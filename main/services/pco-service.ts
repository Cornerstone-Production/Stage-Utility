// Planning Center Online client (Basic Auth: App ID + Secret).
// Flattens JSON:API responses to slim DTOs. ~30s in-memory cache.

import type { PcoAttachmentDTO, PcoLiveDTO, PlanDTO, PlanItemDTO, ServiceTypeDTO, TeamMemberDTO, TeamPositionDTO } from "../types/stage.js";

const PCO_BASE = "https://api.planningcenteronline.com/services/v2";
// Tiered cache TTLs. Slow-changing metadata used to share a single 30s TTL with
// everything, which re-pulled it constantly (the live timer polls every 1–4s and
// the auto-advance check reads plan times every tick). Split by volatility:
//   LONG   — effectively static within a service day (service types, note
//            categories, team positions, plan service times).
//   MEDIUM — plan content that can still be edited up to service time (plan list,
//            plan items, team members, attachments).
//   getLive() stays UNCACHED — it's the live timer and must be real-time.
const CACHE_TTL_MS = 30_000; // default / fallback
const TTL_LONG_MS = 15 * 60_000;
const TTL_MEDIUM_MS = 3 * 60_000;
/** Short-lived cache for attachment `open` signed URLs (PCO issues ~1h links). */
const ATTACH_OPEN_TTL_MS = 10 * 60_000;
/** Retry budget for transient PCO failures (429 / 5xx / network). */
const MAX_RETRIES = 3;

/** True for PCO's auto-generated "initials" placeholder avatar (served at
 *  …/uploads/initials/AB.png when a person has no uploaded photo). Real photos
 *  live under …/uploads/person/…, so this reliably flags "no real photo". */
function isInitialsAvatar(url: string): boolean {
  return /\/uploads\/initials\//i.test(url);
}

/** Near-native size to request from PCO. Source originals are ~1000px square, so
 *  this is the practical ceiling — bigger just upscales. PCO returns a 224×224
 *  thumbnail by default, far too small for the large kiosk cards. */
const AVATAR_PX = 1000;

/** Upgrade a PCO avatar URL to high resolution. PCO's `?g=WxH#` param controls
 *  geometry (# = centered crop); rewrite an existing geometry or append one. */
function highResAvatar(url: string): string {
  if (/[?&]g=\d+x\d+(%23|#)?/.test(url)) {
    return url.replace(/([?&]g=)\d+x\d+(%23|#)?/, `$1${AVATAR_PX}x${AVATAR_PX}%23`);
  }
  return url + (url.includes("?") ? "&" : "?") + `g=${AVATAR_PX}x${AVATAR_PX}%23`;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Generic JSON:API node from PCO
interface PcoNode {
  id: string;
  type?: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data: { id: string; type: string } | null | { id: string; type: string }[] }>;
}

interface PcoResponse<T extends PcoNode = PcoNode> {
  data: T | T[];
  included?: PcoNode[];
}

class PcoService {
  private cache = new Map<string, CacheEntry<unknown>>();

  private cacheGet<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private cacheSet<T>(key: string, value: T, ttlMs: number = CACHE_TTL_MS): void {
    // Bound cache to 200 entries to avoid unbounded growth.
    if (this.cache.size >= 200) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Invalidate every cache entry scoped to one plan (its items, team, service
   *  times, attachments). Used for targeted refresh instead of nuking the lot. */
  clearPlanCache(planId: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.includes(`:${planId}`) || key.endsWith(planId)) this.cache.delete(key);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private makeAuthHeader(appId: string, secret: string): string {
    const creds = Buffer.from(`${appId}:${secret}`).toString("base64");
    return `Basic ${creds}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Backoff for a transient failure on attempt N (0-based). Honors PCO's
   *  Retry-After header when present, else exponential (1s, 2s, 4s) + jitter. */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter ? parseInt(retryAfter, 10) : NaN;
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 15_000);
    return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
  }

  private async request<T extends PcoNode = PcoNode>(
    url: string,
    appId: string,
    secret: string,
  ): Promise<PcoResponse<T>> {
    console.log(`[pco] GET ${url}`);
    // Retry transient failures (429 rate-limit, 5xx, network) with backoff. PCO
    // allows ~100 req / 20s per app; a burst (many displays + a refresh) can 429,
    // which previously threw and dropped data. 401/other-4xx fail fast.
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            Authorization: this.makeAuthHeader(appId, secret),
            "Content-Type": "application/json",
          },
        });
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw err;
        await this.sleep(this.backoffMs(attempt, null));
        continue;
      }

      if (response.status === 401) {
        throw new Error("PCO auth failed — check App ID/Secret in Integrations settings");
      }
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const wait = this.backoffMs(attempt, response.headers.get("Retry-After"));
        console.warn(`[pco] ${response.status} on ${url} — retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await this.sleep(wait);
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`PCO API error ${response.status}: ${body || response.statusText}`);
      }

      const json = await response.json() as PcoResponse<T>;
      console.log(`[pco] OK ${url} (${Array.isArray(json.data) ? (json.data as T[]).length : 1} items)`);
      return json;
    }
  }

  // POST a Services Live controller action (no JSON body; PCO returns the updated
  // live object or 204). Surfaces PCO's error text so the UI can toast it.
  private async postAction(url: string, appId: string, secret: string): Promise<void> {
    console.log(`[pco] POST ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.makeAuthHeader(appId, secret),
        "Content-Type": "application/json",
      },
    });
    if (response.status === 401) {
      throw new Error("PCO auth failed — check App ID/Secret in Integrations settings");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`PCO live control error ${response.status}: ${body || response.statusText}`);
    }
  }

  /**
   * Advance / rewind the PCO Services Live controller — the same "go to next /
   * previous item" actions as PCO's own live timer. Resolves the singleton live
   * controller id for the plan, then POSTs the action. Requires the connected
   * account to be a live controller (PCO returns 4xx otherwise — surfaced to the UI).
   */
  async controlLive(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
    direction: "next" | "previous",
  ): Promise<void> {
    const base = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}`;
    const json = await this.request(`${base}/live`, appId, secret);
    const live = (Array.isArray(json.data) ? json.data[0] : json.data) as PcoNode | undefined;
    if (!live) throw new Error("No PCO live session for this plan");
    const action = direction === "next" ? "go_to_next_item" : "go_to_previous_item";
    // PCO exposes the action URL in the live resource's `links` — use it. The
    // Live resource is a singleton, so the path has NO live id (the fallback
    // `.../live/{action}` matches; an id in the path 404s).
    const linkUrl = (live as unknown as { links?: Record<string, string> }).links?.[action];
    const url = typeof linkUrl === "string" && linkUrl ? linkUrl : `${base}/live/${action}`;
    await this.postAction(url, appId, secret);
  }

  // POST that parses + returns the JSON body (the Live controls' postAction
  // discards it). Used by attachment `open`, which returns a temporary link.
  private async postJson<T extends PcoNode = PcoNode>(
    url: string,
    appId: string,
    secret: string,
  ): Promise<PcoResponse<T>> {
    console.log(`[pco] POST ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.makeAuthHeader(appId, secret),
        "Content-Type": "application/json",
      },
    });
    if (response.status === 401) {
      throw new Error("PCO auth failed — check App ID/Secret in Integrations settings");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`PCO API error ${response.status}: ${body || response.statusText}`);
    }
    return (await response.json()) as PcoResponse<T>;
  }

  /** Human label for where a file is attached (so the picker can disambiguate). */
  private attachableLabel(item: PcoNode): string | null {
    const rel = item.relationships?.attachable?.data;
    const t = rel && !Array.isArray(rel) ? rel.type : null;
    switch (t) {
      case "Plan": return "Plan file";
      case "ServiceType": return "Service type";
      case "Arrangement": return "Song chart";
      case "Song": return "Song";
      case "Item": return "Item";
      case "Media": return "Media";
      default: return t ?? null;
    }
  }

  private mapAttachment(item: PcoNode): PcoAttachmentDTO {
    const a = item.attributes;
    const pageOrderRaw = a.page_order;
    return {
      id: item.id,
      filename: String(a.filename ?? a.name ?? "file"),
      contentType: a.content_type != null && String(a.content_type) !== "" ? String(a.content_type) : null,
      fileSizeBytes: typeof a.file_size === "number" ? a.file_size : null,
      thumbnailUrl: a.thumbnail_url != null && String(a.thumbnail_url) !== "" ? String(a.thumbnail_url) : null,
      pageOrder:
        typeof pageOrderRaw === "number"
          ? pageOrderRaw
          : pageOrderRaw != null && Number.isFinite(Number(pageOrderRaw))
            ? Number(pageOrderRaw)
            : null,
      sourceLabel: this.attachableLabel(item),
    };
  }

  /**
   * Every file associated with a plan via the `all_attachments` endpoint — plan
   * Files (e.g. the stage plot), service-type files, and item/song/arrangement
   * charts in a single paginated call. (The plain `/attachments` endpoint only
   * returns directly-attached plan files and can report 0 even when the plan has
   * a stage plot, so `all_attachments` is the correct source.) Cached ~30s.
   */
  async listPlanAttachments(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<PcoAttachmentDTO[]> {
    const cacheKey = `attachments:${appId}:${planId}`;
    const cached = this.cacheGet<PcoAttachmentDTO[]>(cacheKey);
    if (cached) return cached;

    const out: PcoAttachmentDTO[] = [];
    const seen = new Set<string>();
    let url: string | null =
      `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/all_attachments?per_page=100`;

    // Follow pagination (bounded) so big plans don't truncate, without runaway loops.
    for (let page = 0; url && page < 6; page++) {
      const json: PcoResponse & { links?: { next?: string } } = await this.request(url, appId, secret);
      for (const n of Array.isArray(json.data) ? json.data : [json.data]) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          out.push(this.mapAttachment(n));
        }
      }
      const next = json.links?.next;
      url = typeof next === "string" && next ? next : null;
    }

    this.cacheSet(cacheKey, out, TTL_MEDIUM_MS);
    return out;
  }

  /**
   * Request a temporary download link for a plan attachment. PCO only hands out
   * short-lived (≈1h) S3 URLs via the `open` action, so callers should download
   * promptly (we cache the bytes by attachment id, which is immutable). Not cached
   * here since the link expires.
   */
  async openAttachment(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
    attachmentId: string,
  ): Promise<{ url: string; contentType: string | null }> {
    // Cache the signed URL briefly so N kiosks showing the same plan file don't
    // each POST an `open` (PCO links last ~1h; we keep ours well under that).
    const cacheKey = `attach-open:${attachmentId}`;
    const cached = this.cacheGet<{ url: string; contentType: string | null }>(cacheKey);
    if (cached) return cached;

    // `all_attachments/{id}/open` is the uniform open action for every attachable
    // type (plan file, service-type file, item/arrangement chart).
    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/all_attachments/${attachmentId}/open`;
    const json = await this.postJson(url, appId, secret);
    const node = (Array.isArray(json.data) ? json.data[0] : json.data) as PcoNode | undefined;
    const a = node?.attributes ?? {};
    const dl = a.attachment_url ?? a.url;
    if (typeof dl !== "string" || !dl) {
      throw new Error("PCO did not return a download URL for this attachment");
    }
    const ct = a.content_type;
    const result = { url: dl, contentType: typeof ct === "string" && ct ? ct : null };
    this.cacheSet(cacheKey, result, ATTACH_OPEN_TTL_MS);
    return result;
  }

  async listServiceTypes(appId: string, secret: string): Promise<ServiceTypeDTO[]> {
    const cacheKey = `service-types:${appId}`;
    const cached = this.cacheGet<ServiceTypeDTO[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types?per_page=100`;
    const json = await this.request(url, appId, secret);
    const items = Array.isArray(json.data) ? json.data : [json.data];

    const result: ServiceTypeDTO[] = items.map((item) => ({
      id: item.id,
      name: String(item.attributes.name ?? "Unknown"),
    }));

    this.cacheSet(cacheKey, result, TTL_LONG_MS);
    return result;
  }

  async listUpcomingPlans(
    appId: string,
    secret: string,
    serviceTypeId: string,
  ): Promise<PlanDTO[]> {
    const cacheKey = `plans:${appId}:${serviceTypeId}`;
    const cached = this.cacheGet<PlanDTO[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans?filter=future&order=sort_date&per_page=25`;
    const json = await this.request(url, appId, secret);
    const items = Array.isArray(json.data) ? json.data : [json.data];

    const result: PlanDTO[] = items.map((item) => ({
      id: item.id,
      title: String(item.attributes.title ?? item.attributes.series_title ?? item.attributes.dates ?? "Untitled"),
      seriesTitle: item.attributes.series_title != null && String(item.attributes.series_title) !== ""
        ? String(item.attributes.series_title)
        : null,
      sortDate: item.attributes.sort_date != null ? String(item.attributes.sort_date) : null,
      dates: item.attributes.dates != null ? String(item.attributes.dates) : null,
    }));

    this.cacheSet(cacheKey, result, TTL_MEDIUM_MS);
    return result;
  }

  /** Ordered note-category names for a service type (the script columns). Cached. */
  async listItemNoteCategories(
    appId: string,
    secret: string,
    serviceTypeId: string,
  ): Promise<string[]> {
    const cacheKey = `note-categories:${appId}:${serviceTypeId}`;
    const cached = this.cacheGet<string[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/item_note_categories?per_page=100`;
    const json = await this.request(url, appId, secret).catch(() => null);
    const items = json && Array.isArray(json.data) ? json.data : [];
    const result = items
      .map((n) => ({
        name: typeof n.attributes.name === "string" ? n.attributes.name : "",
        sequence: typeof n.attributes.sequence === "number" ? n.attributes.sequence : 0,
      }))
      .filter((c) => c.name)
      .sort((a, b) => a.sequence - b.sequence)
      .map((c) => c.name);

    this.cacheSet(cacheKey, result, TTL_LONG_MS);
    return result;
  }

  /**
   * The full ordered rundown of a plan's items, with each item's notes grouped by
   * note-category name (the Audio/Band/MD/Vocals columns). `item_type === "header"`
   * marks a section row. Paginated + cached ~30s.
   */
  async listPlanItems(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<PlanItemDTO[]> {
    const cacheKey = `plan-items:${appId}:${planId}`;
    const cached = this.cacheGet<PlanItemDTO[]>(cacheKey);
    if (cached) return cached;

    const out: PlanItemDTO[] = [];
    let url: string | null =
      `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/items?include=item_notes&per_page=100`;

    for (let page = 0; url && page < 6; page++) {
      const json: PcoResponse & { links?: { next?: string } } = await this.request(url, appId, secret);
      const items = Array.isArray(json.data) ? json.data : [json.data];

      // Index included ItemNote nodes by id (carry content + category_name).
      const notesById = new Map<string, { category: string; content: string }>();
      for (const n of json.included ?? []) {
        if (n.type !== "ItemNote") continue;
        const category = typeof n.attributes.category_name === "string" ? n.attributes.category_name : "";
        const content = typeof n.attributes.content === "string" ? n.attributes.content : "";
        if (category && content) notesById.set(n.id, { category, content });
      }

      for (const item of items) {
        const a = item.attributes;
        const noteRefs = item.relationships?.item_notes?.data;
        const notesByCategory: Record<string, string> = {};
        if (Array.isArray(noteRefs)) {
          for (const ref of noteRefs) {
            const note = notesById.get(ref.id);
            if (note) notesByCategory[note.category] = note.content;
          }
        }
        out.push({
          id: item.id,
          title: String(a.title ?? a.description ?? "Untitled"),
          itemType: typeof a.item_type === "string" ? a.item_type : "item",
          lengthSec: typeof a.length === "number" ? a.length : 0,
          sequence: typeof a.sequence === "number" ? a.sequence : out.length,
          notesByCategory,
          description: typeof a.description === "string" && a.description ? a.description : null,
        });
      }

      const next = json.links?.next;
      url = typeof next === "string" && next ? next : null;
    }

    out.sort((a, b) => a.sequence - b.sequence);
    this.cacheSet(cacheKey, out, TTL_MEDIUM_MS);
    return out;
  }

  async listTeamMembers(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<TeamMemberDTO[]> {
    const cacheKey = `team:${appId}:${serviceTypeId}:${planId}`;
    const cached = this.cacheGet<TeamMemberDTO[]>(cacheKey);
    if (cached) return cached;

    const url =
      `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/team_members?include=person,team&per_page=100`;
    const json = await this.request(url, appId, secret);
    const items = Array.isArray(json.data) ? json.data : [json.data];

    // Build lookup for included person/team nodes.
    const includedById = new Map<string, PcoNode>();
    for (const node of json.included ?? []) {
      includedById.set(`${node.id}`, node);
    }

    const result: TeamMemberDTO[] = items.map((item) => {
      const personRel = item.relationships?.person?.data;
      const teamRel = item.relationships?.team?.data;

      let personId: string | null = null;
      let photoUrl: string | null = null;
      let teamName: string | null = null;

      if (personRel && !Array.isArray(personRel)) {
        personId = personRel.id;
        const personNode = includedById.get(personRel.id);
        if (personNode) {
          // PCO Person exposes photo_thumbnail_url / photo_url; try variants.
          const attrs = personNode.attributes;
          photoUrl =
            (attrs.photo_thumbnail_url != null && String(attrs.photo_thumbnail_url)) ||
            (attrs.photo_url != null && String(attrs.photo_url)) ||
            (attrs.avatar != null && String(attrs.avatar)) ||
            (attrs.photo_thumbnail != null && String(attrs.photo_thumbnail)) ||
            null;
        }
        // Fall back to photo fields on the team_member item itself.
        if (!photoUrl) {
          const a = item.attributes;
          photoUrl =
            (a.photo_thumbnail_url != null && String(a.photo_thumbnail_url)) ||
            (a.photo_url != null && String(a.photo_url)) ||
            (a.avatar != null && String(a.avatar)) ||
            (a.photo_thumbnail != null && String(a.photo_thumbnail)) ||
            null;
        }
        // PCO returns an auto-generated gray "initials" avatar for people with no
        // real photo (…/uploads/initials/AB.png). Treat those as no photo so the
        // kiosk shows our themed default avatar; otherwise upgrade the real photo
        // from PCO's 224px default to a near-native high-res crop.
        if (photoUrl) {
          if (isInitialsAvatar(photoUrl)) photoUrl = null;
          else photoUrl = highResAvatar(photoUrl);
        }
      }

      if (teamRel && !Array.isArray(teamRel)) {
        const teamNode = includedById.get(teamRel.id);
        if (teamNode) {
          teamName = teamNode.attributes.name != null ? String(teamNode.attributes.name) : null;
        }
      }

      return {
        id: item.id,
        name: String(item.attributes.name ?? "Unknown"),
        personId,
        photoUrl,
        teamPositionName:
          item.attributes.team_position_name != null
            ? String(item.attributes.team_position_name)
            : null,
        teamName,
        status: String(item.attributes.status ?? "U"),
        notes:
          item.attributes.notes != null && String(item.attributes.notes) !== ""
            ? String(item.attributes.notes)
            : null,
      };
    });

    // Exclude declined team members — they're not serving this plan, so a slot
    // must never resolve to them. PCO `status` is "C" (confirmed), "U"
    // (unconfirmed), or "D" (declined); match leniently in case the API returns
    // the word form.
    const attending = result.filter((m) => {
      const s = m.status.trim().toUpperCase();
      return s !== "D" && s !== "DECLINED";
    });

    this.cacheSet(cacheKey, attending, TTL_MEDIUM_MS);
    return attending;
  }

  async listTeamPositions(
    appId: string,
    secret: string,
    serviceTypeId: string,
  ): Promise<TeamPositionDTO[]> {
    const cacheKey = `team-positions:${appId}:${serviceTypeId}`;
    const cached = this.cacheGet<TeamPositionDTO[]>(cacheKey);
    if (cached) return cached;

    // One compound request: teams + their positions via `include=team_positions`
    // (was 1 + N: a teams call, then a positions call PER team). Falls back to the
    // per-team loop if this PCO endpoint doesn't honor the include.
    const teamsUrl = `${PCO_BASE}/service_types/${serviceTypeId}/teams?include=team_positions&per_page=100`;
    const teamsJson = await this.request(teamsUrl, appId, secret);
    const teams = Array.isArray(teamsJson.data) ? teamsJson.data : [teamsJson.data];

    const positionsById = new Map<string, PcoNode>();
    for (const n of teamsJson.included ?? []) {
      if (n.type === "TeamPosition") positionsById.set(n.id, n);
    }

    const allPositions: TeamPositionDTO[] = [];
    if (positionsById.size > 0) {
      for (const team of teams) {
        const teamName = String(team.attributes.name ?? "Unknown");
        const rel = team.relationships?.team_positions?.data;
        const refs = Array.isArray(rel) ? rel : rel ? [rel] : [];
        for (const ref of refs) {
          const pos = positionsById.get(ref.id);
          if (pos) {
            allPositions.push({ teamId: team.id, teamName, positionName: String(pos.attributes.name ?? "Unknown") });
          }
        }
      }
    } else {
      // Fallback: include not honored — fetch positions per team in parallel.
      await Promise.all(
        teams.map(async (team) => {
          const posUrl = `${PCO_BASE}/service_types/${serviceTypeId}/teams/${team.id}/team_positions?per_page=100`;
          const posJson = await this.request(posUrl, appId, secret);
          const positions = Array.isArray(posJson.data) ? posJson.data : [posJson.data];
          for (const pos of positions) {
            allPositions.push({
              teamId: team.id,
              teamName: String(team.attributes.name ?? "Unknown"),
              positionName: String(pos.attributes.name ?? "Unknown"),
            });
          }
        }),
      );
    }

    this.cacheSet(cacheKey, allPositions, TTL_LONG_MS);
    return allPositions;
  }

  /**
   * Mirror PCO's green timer, which always counts DOWN. While a plan item is live
   * → that item's planned length from when it went live ("item" mode). Otherwise
   * → the time until the service starts ("preservice" mode, e.g. PCO's "6 days").
   * "none" when neither is available. One /live request (+ a cached plan_times
   * lookup for the service start). NOT cached for the live part — polled live.
   */
  async getLive(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<PcoLiveDTO> {
    const serverNow = new Date().toISOString();
    const base = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}`;
    const json = await this.request(`${base}/live?include=items,current_item_time`, appId, secret);
    const live = (Array.isArray(json.data) ? json.data[0] : json.data) as PcoNode | undefined;
    const included = json.included ?? [];

    // ── "item" mode: a plan item is currently live. ──
    // (current_item_time must resolve to one of THIS plan's items — its item is in
    // the `items` include. A session whose item isn't ours, or no session at all,
    // falls through to the preservice countdown below.)
    const currentRef = live?.relationships?.["current_item_time"]?.data;
    const currentId = currentRef && !Array.isArray(currentRef) ? currentRef.id : null;
    const it = currentId ? included.find((n) => n.id === currentId) : null;
    const liveStartAt = it?.attributes?.live_start_at;
    const itemRef = it?.relationships?.["item"]?.data;
    const itemId = itemRef && !Array.isArray(itemRef) ? itemRef.id : null;
    const itemNode =
      itemId ? included.find((n) => n.type === "Item" && n.id === itemId) : null;

    if (it && typeof liveStartAt === "string" && liveStartAt && itemNode) {
      // "Full Item Length" = the *plan item's* length (ItemTime.length is often 0)
      // plus any live length_offset the operator set.
      const planLen =
        typeof itemNode.attributes.length === "number" ? (itemNode.attributes.length as number) : 0;
      const offset =
        typeof it.attributes.length_offset === "number" ? it.attributes.length_offset : 0;
      const adjLen = planLen + offset;
      return {
        mode: "item",
        currentItemId: itemId,
        label: typeof itemNode.attributes.title === "string" ? itemNode.attributes.title : null,
        lengthSec: adjLen > 0 ? adjLen : null,
        liveStartAt,
        targetAt: null,
        serverNow,
      };
    }

    // ── "preservice" mode: count down to the service start (PCO's pre-service timer). ──
    const startAt = await this.getServiceStart(appId, secret, serviceTypeId, planId);
    if (startAt) {
      return {
        mode: "preservice",
        currentItemId: null,
        label: "Service starts",
        lengthSec: null,
        liveStartAt: null,
        targetAt: startAt,
        serverNow,
      };
    }

    return { mode: "none", currentItemId: null, label: null, lengthSec: null, liveStartAt: null, targetAt: null, serverNow };
  }

  /**
   * Fetch + cache a plan's "service" plan_times ONCE (start countdown and
   * auto-rollover end both derive from this). Previously start + end each made a
   * separate request to the identical /plan_times URL; this collapses them to one
   * call per plan, cached LONG since service times are effectively static day-of.
   */
  private async getServiceTimes(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<{ startsAt: string; endsAt: string | null }[]> {
    const cacheKey = `plan-times:${planId}`;
    const cached = this.cacheGet<{ startsAt: string; endsAt: string | null }[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/plan_times`;
    const json = await this.request(url, appId, secret).catch(() => null);
    const times = json && Array.isArray(json.data) ? json.data : [];
    const services = times
      .filter((t) => t.attributes.time_type === "service")
      .map((t) => ({
        startsAt: typeof t.attributes.starts_at === "string" ? t.attributes.starts_at : null,
        endsAt: typeof t.attributes.ends_at === "string" ? t.attributes.ends_at : null,
      }))
      .filter((t): t is { startsAt: string; endsAt: string | null } => !!t.startsAt);

    this.cacheSet(cacheKey, services, TTL_LONG_MS);
    return services;
  }

  /** Choose the relevant "service" time: the soonest whose end is still in the
   *  future, else the latest. (Same selection start + end always shared.) */
  private pickServiceTime(
    services: { startsAt: string; endsAt: string | null }[],
  ): { startsAt: string; endsAt: string | null } | null {
    const now = Date.now();
    const upcoming = services
      .filter((t) => (t.endsAt ? Date.parse(t.endsAt) > now : true))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
    return upcoming ?? services.slice().sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))[0] ?? null;
  }

  /** The plan's service start time (ISO) for the pre-service countdown. */
  private async getServiceStart(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<string | null> {
    const chosen = this.pickServiceTime(await this.getServiceTimes(appId, secret, serviceTypeId, planId));
    return chosen?.startsAt ?? null;
  }

  /** The current plan's service END time (ISO) — used by auto-mode rollover. */
  async getServiceEnd(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<string | null> {
    const chosen = this.pickServiceTime(await this.getServiceTimes(appId, secret, serviceTypeId, planId));
    return chosen?.endsAt ?? null;
  }
}

export const pcoService = new PcoService();
