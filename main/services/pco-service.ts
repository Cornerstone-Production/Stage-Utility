// Planning Center Online client (Basic Auth: App ID + Secret).
// Flattens JSON:API responses to slim DTOs. ~30s in-memory cache.

import type { PcoLiveDTO, PlanDTO, ServiceTypeDTO, TeamMemberDTO, TeamPositionDTO } from "../types/stage.js";

const PCO_BASE = "https://api.planningcenteronline.com/services/v2";
const CACHE_TTL_MS = 30_000;

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

  private cacheSet<T>(key: string, value: T): void {
    // Bound cache to 200 entries to avoid unbounded growth.
    if (this.cache.size >= 200) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  clearCache(): void {
    this.cache.clear();
  }

  private makeAuthHeader(appId: string, secret: string): string {
    const creds = Buffer.from(`${appId}:${secret}`).toString("base64");
    return `Basic ${creds}`;
  }

  private async request<T extends PcoNode = PcoNode>(
    url: string,
    appId: string,
    secret: string,
  ): Promise<PcoResponse<T>> {
    console.log(`[pco] GET ${url}`);
    const response = await fetch(url, {
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

    const json = await response.json() as PcoResponse<T>;
    console.log(`[pco] OK ${url} (${Array.isArray(json.data) ? (json.data as T[]).length : 1} items)`);
    return json;
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

    this.cacheSet(cacheKey, result);
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

    this.cacheSet(cacheKey, result);
    return result;
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

    this.cacheSet(cacheKey, result);
    return result;
  }

  async listTeamPositions(
    appId: string,
    secret: string,
    serviceTypeId: string,
  ): Promise<TeamPositionDTO[]> {
    const cacheKey = `team-positions:${appId}:${serviceTypeId}`;
    const cached = this.cacheGet<TeamPositionDTO[]>(cacheKey);
    if (cached) return cached;

    // Fetch all teams for this service type.
    const teamsUrl = `${PCO_BASE}/service_types/${serviceTypeId}/teams?per_page=100`;
    const teamsJson = await this.request(teamsUrl, appId, secret);
    const teams = Array.isArray(teamsJson.data) ? teamsJson.data : [teamsJson.data];

    // Fetch positions for each team in parallel.
    const allPositions: TeamPositionDTO[] = [];
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

    this.cacheSet(cacheKey, allPositions);
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
        label: "Service starts",
        lengthSec: null,
        liveStartAt: null,
        targetAt: startAt,
        serverNow,
      };
    }

    return { mode: "none", label: null, lengthSec: null, liveStartAt: null, targetAt: null, serverNow };
  }

  /**
   * The plan's service start time (ISO) — the soonest "service" plan_time whose
   * end is still in the future, else the latest. Cached (~30s) since it's static.
   */
  private async getServiceStart(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<string | null> {
    const cacheKey = `plan-start:${planId}`;
    const cached = this.cacheGet<string | null>(cacheKey);
    if (cached !== null) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/plan_times`;
    const json = await this.request(url, appId, secret).catch(() => null);
    const times = json && Array.isArray(json.data) ? json.data : [];
    const services = times
      .filter((t) => t.attributes.time_type === "service")
      .map((t) => ({
        startsAt: typeof t.attributes.starts_at === "string" ? t.attributes.starts_at : null,
        endsAt: typeof t.attributes.ends_at === "string" ? t.attributes.ends_at : null,
      }))
      .filter((t): t is { startsAt: string; endsAt: string } => !!t.startsAt);

    const now = Date.now();
    const upcoming = services
      .filter((t) => (t.endsAt ? Date.parse(t.endsAt) > now : true))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
    const chosen = upcoming ?? services.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))[0];
    const result = chosen?.startsAt ?? null;
    this.cacheSet(cacheKey, result);
    return result;
  }

  /**
   * The current plan's service END time (ISO), choosing the same "service"
   * plan_time getServiceStart would — used by auto-mode rollover. Cached (~30s).
   */
  async getServiceEnd(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<string | null> {
    const cacheKey = `plan-end:${planId}`;
    const cached = this.cacheGet<string | null>(cacheKey);
    if (cached !== null) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/plan_times`;
    const json = await this.request(url, appId, secret).catch(() => null);
    const times = json && Array.isArray(json.data) ? json.data : [];
    const services = times
      .filter((t) => t.attributes.time_type === "service")
      .map((t) => ({
        startsAt: typeof t.attributes.starts_at === "string" ? t.attributes.starts_at : null,
        endsAt: typeof t.attributes.ends_at === "string" ? t.attributes.ends_at : null,
      }))
      .filter((t): t is { startsAt: string; endsAt: string } => !!t.startsAt);

    const now = Date.now();
    const upcoming = services
      .filter((t) => (t.endsAt ? Date.parse(t.endsAt) > now : true))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
    const chosen = upcoming ?? services.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))[0];
    const result = chosen?.endsAt ?? null;
    this.cacheSet(cacheKey, result);
    return result;
  }
}

export const pcoService = new PcoService();
