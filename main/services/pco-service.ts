// Planning Center Online client (Basic Auth: App ID + Secret).
// Flattens JSON:API responses to slim DTOs. ~30s in-memory cache.

import type { PcoAttachmentDTO, PcoItemTypeColor, PcoLiveDTO, PlanDTO, PlanItemDTO, ServiceTypeDTO, TeamMemberDTO, TeamPositionDTO } from "../types/stage.js";
import { scheduleItems } from "./automation-item-schedule.js";
import type { PlanNoteDTO } from "./plan-note-checklist.js";
import { isServiceEndHeader, isServiceStartHeader } from "./pco-plan-markers.js";
import { pickServiceTime } from "./pick-service-time.js";

/**
 * PCO rejected the credentials (401).
 *
 * Its own type because it is a CONFIGURATION fault, not a transient one:
 * retrying cannot fix it, so callers on a timer must stand down rather than
 * ask again every tick. Matching on the message text instead would break the
 * moment the wording changed — and the wording is operator-facing copy.
 */
export class PcoAuthError extends Error {
  constructor() {
    super("PCO auth failed — check App ID/Secret in Integrations settings");
    this.name = "PcoAuthError";
  }
}
import { scrub } from "./scrub.js";

const PCO_BASE = "https://api.planningcenteronline.com/services/v2";

/**
 * Is `candidate` an absolute URL on the same origin as `base`?
 *
 * Used before following a URL that arrived in a response body and will be sent
 * the operator's PCO credentials. Origin, not prefix: a string test would accept
 * `https://api.planningcenteronline.com.evil.example/`. Anything unparseable,
 * relative, or off-origin is rejected, and the caller falls back to a URL it
 * built itself.
 */
export function sameOrigin(candidate: unknown, base: string): candidate is string {
  if (typeof candidate !== "string" || !candidate) return false;
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * The offset of the next page, as a NUMBER.
 *
 * PCO's `links.next` is the same endpoint with `offset` advanced, so the only
 * thing worth taking from it is that integer. Everything else -- host, path,
 * every other query parameter -- we already have, because we built the request
 * that produced this response.
 *
 * Taking a number rather than a URL is what makes following a page structurally
 * safe. pcoUrlFrom rebuilt the host from a constant, which closed the hole, but
 * the path and query still came off the wire; an integer cannot carry a host, a
 * path, or anything else. There is no longer any string from a PCO response body
 * that reaches fetch().
 *
 * @returns the offset, or null when there is no next page or it is not a number.
 */
export function nextOffset(candidate: unknown): number | null {
  if (typeof candidate !== "string" || !candidate) return null;
  let raw: string | null;
  try {
    raw = new URL(candidate).searchParams.get("offset");
  } catch {
    return null;
  }
  // An EMPTY offset is not zero. Number("") is 0, which would send the loop back
  // to the first page and then round again for ever -- a hang on a live server,
  // found by the test below rather than on a Sunday.
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  // Finite, non-negative, integral. Number() on anything else gives NaN, and a
  // negative or fractional offset is not something PCO produces.
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** The same URL with `offset` set. Built from OUR url, never from the response. */
export function withOffset(url: string, offset: number): string {
  const u = new URL(url);
  u.searchParams.set("offset", String(offset));
  return u.toString();
}

/**
 * A URL that arrived in a PCO response body, REBUILT on our own origin.
 *
 * sameOrigin() checks and then hands the original string on. That is correct --
 * a string whose origin equals PCO's cannot point anywhere else -- but the value
 * reaching fetch() is still the one that came off the wire, and every request it
 * makes carries the operator's App ID and secret in an Authorization header.
 *
 * This returns a URL whose HOST comes from the constant, and only the path and
 * query from the candidate. So the host is not checked-and-trusted, it is never
 * taken from the response at all: there is no string an upstream could return
 * that sends the credentials somewhere else, including through a redirect chain
 * or a URL parser disagreement.
 *
 * That sentence was FALSE for two years, and the guard written to prove it did
 * not notice. The path and query used to be spliced back together as a STRING
 * and handed to `new URL(path, origin)` -- and a path beginning `//` is not a
 * path to that constructor, it is a PROTOCOL-RELATIVE URL. So
 * `https://api.planningcenteronline.com//attacker.test/x` passed sameOrigin
 * honestly (the origin really does match), produced the pathname
 * `//attacker.test/x`, and re-resolved to `https://attacker.test/x` -- with the
 * operator's App ID and secret attached. `\\attacker.test` reached the same
 * place, because WHATWG folds a backslash to a slash for a special scheme, so no
 * check on the RAW string would have caught it either.
 *
 * The fix is to stop round-tripping through a string. Assigning `.pathname` on a
 * URL object sets a component; it cannot reach the origin, where the two-argument
 * constructor can. Latent rather than live when found -- nothing was passing a
 * response-body string in -- but the boundary is the entire justification for
 * `requestProduct` being public, so it has to be true rather than nearly true.
 *
 * It also gives static analysis something it can see. CodeQL reads a
 * user-defined type predicate as an ordinary boolean, so the guarded string
 * stayed tainted and js/request-forgery fired at critical on the release PR;
 * building on a hardcoded base is the documented remediation for that query.
 *
 * @returns the rebuilt URL, or null when the candidate is not PCO's.
 */
export function pcoUrlFrom(candidate: unknown, base: string): string | null {
  if (!sameOrigin(candidate, base)) return null;
  try {
    const parsed = new URL(candidate);
    // Built by ASSIGNMENT, never by `new URL(path, origin)`. The setters write
    // one component each and cannot touch the origin; the constructor re-parses
    // its first argument and will happily read `//host` as an authority.
    const rebuilt = new URL(base);
    rebuilt.pathname = parsed.pathname;
    rebuilt.search = parsed.search;
    return rebuilt.toString();
  } catch {
    return null;
  }
}
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
// A request that FAILED is cached for this long, and no longer. Not caching a
// failure at all was the other half of the mistake: getLive() calls getPlanTimes
// on every live tick (~1/s during a service), and its only rate limiter is this
// cache, so a PCO incident turned into ~1 req/s of retries per failing endpoint
// and the app rate-limited itself out of PCO's quota. Long enough to throttle a
// retry storm, short enough that a blip does not blank the countdown for the
// fifteen minutes a success is held for.
const TTL_FAILED_MS = 30_000;
/** Short-lived cache for attachment `open` signed URLs (PCO issues ~1h links). */
const ATTACH_OPEN_TTL_MS = 10 * 60_000;
/** Retry budget for transient PCO failures (429 / 5xx / network). */
const MAX_RETRIES = 3;
/** Concurrent in-flight PCO requests. PCO allows roughly 100 per 20s per app, so
 *  the ceiling is well under that even when every slot is retrying. */
const MAX_CONCURRENT = 4;
// Per-request PCO logging (~2 lines per uncached /live, ~1 Hz during a service) is
// off unless STAGE_UTILITY_DEBUG=1 — keeps an unrotated stdout log from ballooning.
const DEBUG_PCO = process.env.STAGE_UTILITY_DEBUG === "1";

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

/** One PCO plan row → PlanDTO. Shared by the future and past listings. */
function toPlanDTO(item: PcoNode): PlanDTO {
  return {
    id: item.id,
    title: String(item.attributes.title ?? item.attributes.series_title ?? item.attributes.dates ?? "Untitled"),
    seriesTitle:
      item.attributes.series_title != null && String(item.attributes.series_title) !== ""
        ? String(item.attributes.series_title)
        : null,
    sortDate: item.attributes.sort_date != null ? String(item.attributes.sort_date) : null,
    dates: item.attributes.dates != null ? String(item.attributes.dates) : null,
  };
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** A plan's "service" plan_time — one per service occurrence (e.g. 9am, 11am). */
interface ServiceTime {
  id: string;
  startsAt: string;
  endsAt: string | null;
}

/** Any of a plan's times: service occurrences, rehearsal, call times, and the
 *  named ones a church adds for its own cues. Named times are the only exact
 *  clock PCO offers for a point inside a plan — Items carry no time at all. */
interface PlanTime extends ServiceTime {
  name: string | null;
  timeType: string;
}

/**
 * Current + next item titles from the PLAN order (the authoritative rundown),
 * given the live item id. "next" skips header rows; with no live item yet it's the
 * first non-header item. Drives the Current/Next display blocks from PCO, so an
 * off-plan ProPresenter playlist can't leak an item that isn't in today's plan.
 */
export function resolvePlanCurrentNext(
  items: PlanItemDTO[],
  currentItemId: string | null,
): { currentItemTitle: string | null; nextItemTitle: string | null } {
  if (items.length === 0) return { currentItemTitle: null, nextItemTitle: null };
  const idx = currentItemId ? items.findIndex((i) => i.id === currentItemId) : -1;
  const current = idx >= 0 ? items[idx] : null;
  let next: PlanItemDTO | null = null;
  for (let i = idx + 1; i < items.length; i++) {
    if (items[i].itemType !== "header") {
      next = items[i];
      break;
    }
  }
  return { currentItemTitle: current?.title ?? null, nextItemTitle: next?.title ?? null };
}

// Generic JSON:API node from PCO. Exported because every PCO product speaks the
// same JSON:API dialect, so a client for another one (Calendar) parses the same
// shape rather than declaring its own copy of it.
export interface PcoNode {
  id: string;
  type?: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data: { id: string; type: string } | null | { id: string; type: string }[] }>;
}

export interface PcoResponse<T extends PcoNode = PcoNode> {
  data: T | T[];
  included?: PcoNode[];
}

/** Normalise PCO's item-type arrays. Anything without a usable name + #rrggbb is
 *  dropped rather than guessed at. */
function toItemColors(raw: unknown, custom: boolean): PcoItemTypeColor[] {
  if (!Array.isArray(raw)) return [];
  const out: PcoItemTypeColor[] = [];
  for (const e of raw) {
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    const color = typeof e?.color === "string" ? e.color.trim().toLowerCase() : "";
    if (!name || !/^#[0-9a-f]{6}$/.test(color)) continue;
    out.push({ name, color, custom });
  }
  return out;
}

class PcoService {
  /** One-shot: log the Live session's available actions the first time we drive it. */
  private static loggedLiveActions = false;
  private inFlight = 0;
  private pending: (() => void)[] = [];

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
    apiVersion?: string,
  ): Promise<PcoResponse<T>> {
    // Every PCO call queues here. Retrying a 429 does not help if the burst that
    // caused it is still in flight, so the cap is what actually prevents one —
    // any fan-out over plans or service types is throttled rather than trusted to
    // be small.
    const release = await this.acquireSlot();
    try {
      return await this.requestInner<T>(url, appId, secret, apiVersion);
    } finally {
      release();
    }
  }

  /**
   * A GET against ANOTHER Planning Center product's API — Calendar, today —
   * carried by this client's transport.
   *
   * PCO's rate limit is per APP, not per product, so a second client with its own
   * concurrency gate would not be a second budget: it would be the same budget
   * spent twice as fast, and the cap that exists to prevent a 429 would stop
   * capping anything. Sharing the transport is the only way the ceiling stays a
   * ceiling. The retry budget, the backoff, the auth header and the scrubbed
   * logging come along for the same reason — none of them is worth a second copy.
   *
   * `apiVersion` is REQUIRED here, unlike on the internal `request`. PCO versions
   * each product by date and resolves the header to the newest published version
   * at or before it; send nothing and you get whatever is configured as the app's
   * default in a developer console outside this repository. A caller reaching a
   * new product must therefore state which contract it was written against.
   *
   * `url` is REBUILT on the constant's origin before it is used, exactly as
   * pcoUrlFrom does for a link out of a response body. Every request from here
   * carries the operator's App ID and secret, and this is the first PUBLIC way
   * into the credentialed fetch — until now the invariant "no outside string
   * reaches it" held because `request` was private and every URL was built in
   * this file. A docstring asking callers to behave would have traded that for a
   * rule someone has to remember; rebuilding the host from the constant keeps it
   * a property of the code, and is the documented remediation for the
   * js/request-forgery alerts this file has already collected once.
   *
   * @throws when `url` is not on PCO's origin, rather than sending credentials.
   */
  async requestProduct<T extends PcoNode = PcoNode>(
    url: string,
    appId: string,
    secret: string,
    apiVersion: string,
  ): Promise<PcoResponse<T>> {
    // The origin is the CONSTANT's; only the path and query come from the
    // caller. There is no string it can pass that sends the credentials
    // elsewhere, including through a parser disagreement.
    const safe = pcoUrlFrom(url, PCO_BASE);
    if (!safe) throw new Error(`[pco] refusing to send credentials to ${scrub(url)}`);
    return this.request<T>(safe, appId, secret, apiVersion);
  }

  /** Wait for a free request slot; resolves with the function that frees it. */
  private acquireSlot(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.inFlight++;
        let released = false;
        resolve(() => {
          if (released) return; // a double release would over-grant the pool
          released = true;
          this.inFlight--;
          this.pending.shift()?.();
        });
      };
      if (this.inFlight < MAX_CONCURRENT) grant();
      else this.pending.push(grant);
    });
  }

  private async requestInner<T extends PcoNode = PcoNode>(
    url: string,
    appId: string,
    secret: string,
    apiVersion?: string,
  ): Promise<PcoResponse<T>> {
    if (DEBUG_PCO) console.log(`[pco] GET ${scrub(url)}`);
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
            // Omitted entirely when absent, so every existing /services/v2 call
            // sends the byte-identical header set it sent before. Pinning those
            // is a separate change on its own branch; this is the hook the
            // Calendar client pins itself through in the meantime.
            ...(apiVersion ? { "X-PCO-API-Version": apiVersion } : {}),
          },
        });
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw err;
        await this.sleep(this.backoffMs(attempt, null));
        continue;
      }

      if (response.status === 401) {
        throw new PcoAuthError();
      }
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const wait = this.backoffMs(attempt, response.headers.get("Retry-After"));
        console.warn(`[pco] ${scrub(response.status)} on ${scrub(url)} — retrying in ${scrub(wait)}ms (attempt ${scrub(attempt + 1)}/${scrub(MAX_RETRIES)})`);
        await this.sleep(wait);
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`PCO API error ${response.status}: ${body || response.statusText}`);
      }

      const json = await response.json() as PcoResponse<T>;
      if (DEBUG_PCO) console.log(`[pco] OK ${scrub(url)} (${scrub(Array.isArray(json.data) ? (json.data as T[]).length : 1)} items)`);
      return json;
    }
  }

  // POST a Services Live controller action (no JSON body; PCO returns the updated
  // live object or 204). Surfaces PCO's error text so the UI can toast it.
  private async postAction(url: string, appId: string, secret: string): Promise<void> {
    console.log(`[pco] POST ${scrub(url)}`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.makeAuthHeader(appId, secret),
        "Content-Type": "application/json",
      },
    });
    if (response.status === 401) {
      throw new PcoAuthError();
    }
    if (response.status === 403) {
      // Almost always: no Live session is actually running for this plan, or the
      // connected Planning Center account isn't a permitted Live controller.
      throw new Error(
        "Can't control PCO Live — start a Live session for this plan in Planning Center, and make sure the connected account can control Live for this service type.",
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`PCO live control failed (${response.status}). ${response.statusText || body}`);
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
    const links = (live as unknown as { links?: Record<string, string> }).links ?? {};
    // Log every action PCO offers on this Live session, once per run. We only
    // consume next/previous, so whether PCO can jump straight to an item has been
    // an open question - and the answer is in this object rather than in the
    // documentation. Automating "fire the Doors item" is materially safer with a
    // direct jump than by stepping through (and firing) everything in between.
    if (!PcoService.loggedLiveActions) {
      PcoService.loggedLiveActions = true;
      console.log(`[pco] live actions offered: ${scrub(Object.keys(links).sort().join(", ") || "(none)")}`);
    }
    // BUILT, never followed.
    //
    // This URL is POSTed to with the operator's App ID and secret in an
    // Authorization header, so a host from a response body would be handed the
    // credentials. It used to take PCO's own link when that link's origin
    // checked out, and fall back to this constructed URL otherwise -- which
    // means the constructed URL was already the trusted answer.
    //
    // So it is the only answer now. No string from the body reaches fetch(), and
    // there is nothing left to check. `links` still says which actions PCO is
    // offering, which is what it is read for above.
    //
    // If PCO ever moves the endpoint, this says so rather than silently posting
    // to the wrong place -- the one case where the old code would have differed.
    const linkUrl = links[action];
    const url = `${base}/live/${action}`;
    const offered = pcoUrlFrom(linkUrl, PCO_BASE);
    if (offered && new URL(offered).pathname !== new URL(url).pathname) {
      console.warn(
        `[pco] live "${scrub(action)}" link points somewhere unexpected; using the documented endpoint`,
      );
    }
    await this.postAction(url, appId, secret);
  }

  // POST that parses + returns the JSON body (the Live controls' postAction
  // discards it). Used by attachment `open`, which returns a temporary link.
  private async postJson<T extends PcoNode = PcoNode>(
    url: string,
    appId: string,
    secret: string,
  ): Promise<PcoResponse<T>> {
    console.log(`[pco] POST ${scrub(url)}`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.makeAuthHeader(appId, secret),
        "Content-Type": "application/json",
      },
    });
    if (response.status === 401) {
      throw new PcoAuthError();
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
    // Highest offset already requested, so a next-link that does not move forward
    // ends the loop instead of repeating a page for ever.
    let seenOffset = -1;
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
      // An OFFSET, not a URL. `links.next` arrives in a response BODY and used to
      // be handed straight back to request(), which attaches the operator's PCO
      // credentials -- so a redirected or spoofed response could walk them to
      // another host. Taking only the integer means no string from the body
      // reaches fetch() at all; the rest of the URL is the one we built.
      // Strictly forward. A next-link that repeats or rewinds the offset would
      // otherwise fetch the same page for ever; PCO does not do that, which is
      // exactly why nothing would catch it if it started.
      const offset = nextOffset(json.links?.next);
      url = offset === null || offset <= seenOffset ? null : withOffset(url, offset);
      seenOffset = offset ?? seenOffset;
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
      // Free: this resource already carries the colors, we just stopped throwing
      // them away. `index` is PCO's palette slot and is not useful to us.
      itemTypeColors: [
        ...toItemColors(item.attributes.standard_item_types, false),
        ...toItemColors(item.attributes.custom_item_types, true),
      ],
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

    const result: PlanDTO[] = items.map(toPlanDTO);

    this.cacheSet(cacheKey, result, TTL_MEDIUM_MS);
    return result;
  }

  /**
   * Recently-past plans, newest first — for the manual picker only.
   *
   * Auto plan selection and the reconnect windows deliberately keep using
   * `listUpcomingPlans`: a past plan must never be auto-selected, and a window
   * derived from one would already have closed.
   */
  async listRecentPlans(
    appId: string,
    secret: string,
    serviceTypeId: string,
    days = 30,
  ): Promise<PlanDTO[]> {
    const cacheKey = `plans:past:${appId}:${serviceTypeId}:${days}`;
    const cached = this.cacheGet<PlanDTO[]>(cacheKey);
    if (cached) return cached;

    // PCO orders `past` oldest-first, so ask in reverse to get the most recent
    // page rather than the oldest plans this service type ever had.
    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans?filter=past&order=-sort_date&per_page=25`;
    const json = await this.request(url, appId, secret);
    const items = Array.isArray(json.data) ? json.data : [json.data];

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = items
      .map(toPlanDTO)
      .filter((p) => {
        const t = p.sortDate ? Date.parse(p.sortDate) : NaN;
        return Number.isFinite(t) && t >= cutoff;
      });

    this.cacheSet(cacheKey, result, TTL_MEDIUM_MS);
    return result;
  }

  /** Ordered note-category names for a service type (the script columns). Cached. */
  async listItemNoteCategories(
    appId: string,
    secret: string,
    serviceTypeId: string,
  ): Promise<string[]> {
    return this.noteCategoryNames(appId, secret, serviceTypeId, "item_note_categories");
  }

  /**
   * Ordered names from a `*_note_categories` collection on a service type.
   *
   * Shared by the item-note columns and the plan-note categories, which are two
   * different endpoints returning the same shape. Written once because this
   * repository's most expensive recurring mistake is fixing one copy of a thing
   * that exists in several — the pagination, the sequence sort and the
   * do-not-cache-a-failure rule would all have had to be got right twice.
   */
  private async noteCategoryNames(
    appId: string,
    secret: string,
    serviceTypeId: string,
    collection: "item_note_categories" | "plan_note_categories",
  ): Promise<string[]> {
    const cacheKey = `${collection}:${appId}:${serviceTypeId}`;
    const cached = this.cacheGet<string[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/${collection}?per_page=100`;
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

    // Only cache a real answer. A failed request parses to an empty list, and
    // caching that would store a FAILURE as data, with a success's TTL.
    this.cacheSet(cacheKey, result, json ? TTL_LONG_MS : TTL_FAILED_MS);
    return result;
  }

  /** The plan-note categories a service type offers, for the checklist picker. */
  async listPlanNoteCategories(appId: string, secret: string, serviceTypeId: string): Promise<string[]> {
    return this.noteCategoryNames(appId, secret, serviceTypeId, "plan_note_categories");
  }

  /**
   * Every team name on a service type, for the checklist picker.
   *
   * Its own request rather than deriving from listTeamPositions, which already
   * has the teams cached: a team with no positions defined does not appear
   * there, and a picker that silently omits an option somebody uses is worse
   * than one extra request every fifteen minutes.
   */
  async listTeamNames(appId: string, secret: string, serviceTypeId: string): Promise<string[]> {
    const cacheKey = `team-names:${appId}:${serviceTypeId}`;
    const cached = this.cacheGet<string[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/teams?per_page=100`;
    const json = await this.request(url, appId, secret).catch(() => null);
    const items = json && Array.isArray(json.data) ? json.data : [];
    const result = [
      ...new Set(
        items
          .map((n) => (typeof n.attributes.name === "string" ? n.attributes.name : ""))
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));

    this.cacheSet(cacheKey, result, json ? TTL_LONG_MS : TTL_FAILED_MS);
    return result;
  }

  /**
   * A plan's NOTES — the ones written at the top of the plan for a team, not the
   * per-item notes that fill the rundown columns above.
   *
   * These are what a production lead already writes each week ("Assigned Teams"
   * in PCO), so pulling them is what lets one checklist live in one place
   * instead of being copied into this app and going stale.
   *
   * `category_name` rides on the note's own attributes, so grouping by category
   * costs no second request. Team names do need `include=teams`.
   */
  async listPlanNotes(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<PlanNoteDTO[]> {
    const cacheKey = `plan-notes:${appId}:${planId}`;
    const cached = this.cacheGet<PlanNoteDTO[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/notes?include=teams&per_page=100`;
    const json = await this.request(url, appId, secret);
    const nodes = Array.isArray(json.data) ? json.data : [json.data];

    const teamById = new Map<string, string>();
    for (const n of json.included ?? []) {
      if (n.type === "Team" && typeof n.attributes.name === "string" && n.attributes.name) {
        teamById.set(n.id, n.attributes.name);
      }
    }

    const out: PlanNoteDTO[] = [];
    for (const node of nodes) {
      if (!node) continue;
      const content = typeof node.attributes.content === "string" ? node.attributes.content : "";
      if (!content.trim()) continue; // an empty note is not a note
      // PCO documents `teams` as to_one, but the plan editor lets a note be
      // assigned to SEVERAL teams and then sends an array. Reading only one
      // shape would drop every team on a multi-team note — silently, and only
      // for the churches that use the feature the most.
      const rel = node.relationships?.teams?.data;
      const refs = Array.isArray(rel) ? rel : rel ? [rel] : [];
      out.push({
        id: node.id,
        categoryName: typeof node.attributes.category_name === "string" ? node.attributes.category_name : "",
        content,
        teamNames: refs.map((r) => teamById.get(r.id)).filter((n): n is string => !!n),
      });
    }

    // One page only, on purpose: a plan carries a handful of notes, not
    // hundreds. Said out loud rather than truncated in silence, so a church that
    // somehow passes 100 leaves a trace instead of losing rows off the bottom.
    if (nodes.length >= 100) {
      console.warn(`[pco] plan ${scrub(planId)} returned a full page of notes; any beyond 100 are not shown`);
    }

    this.cacheSet(cacheKey, out, TTL_MEDIUM_MS);
    return out;
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
    // Highest offset already requested, so a next-link that does not move forward
    // ends the loop instead of repeating a page for ever.
    let seenOffset = -1;
    let url: string | null =
      `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/items?include=item_notes,arrangement&per_page=100`;

    for (let page = 0; url && page < 6; page++) {
      const json: PcoResponse & { links?: { next?: string } } = await this.request(url, appId, secret);
      const items = Array.isArray(json.data) ? json.data : [json.data];

      // Index included ItemNote nodes by id (carry content + category_name).
      const notesById = new Map<string, { category: string; content: string }>();
      // Index included Arrangement nodes by id (carry bpm + arrangement name).
      const arrById = new Map<string, { bpm: number | null; name: string | null }>();
      for (const n of json.included ?? []) {
        if (n.type === "ItemNote") {
          const category = typeof n.attributes.category_name === "string" ? n.attributes.category_name : "";
          const content = typeof n.attributes.content === "string" ? n.attributes.content : "";
          if (category && content) notesById.set(n.id, { category, content });
        } else if (n.type === "Arrangement") {
          arrById.set(n.id, {
            bpm: typeof n.attributes.bpm === "number" ? n.attributes.bpm : null,
            name: typeof n.attributes.name === "string" && n.attributes.name ? n.attributes.name : null,
          });
        }
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
        const arrRef = item.relationships?.arrangement?.data;
        const arr = arrRef && !Array.isArray(arrRef) ? arrById.get(arrRef.id) : undefined;
        out.push({
          id: item.id,
          title: String(a.title ?? a.description ?? "Untitled"),
          itemType: typeof a.item_type === "string" ? a.item_type : "item",
          lengthSec: typeof a.length === "number" ? a.length : 0,
          sequence: typeof a.sequence === "number" ? a.sequence : out.length,
          notesByCategory,
          description: typeof a.description === "string" && a.description ? a.description : null,
          songKey: typeof a.key_name === "string" && a.key_name ? a.key_name : null,
          bpm: arr?.bpm ?? null,
          arrangementName: arr?.name ?? null,
          servicePosition: typeof a.service_position === "string" ? a.service_position : null,
        });
      }

      // An OFFSET, not a URL. `links.next` arrives in a response BODY and used to
      // be handed straight back to request(), which attaches the operator's PCO
      // credentials -- so a redirected or spoofed response could walk them to
      // another host. Taking only the integer means no string from the body
      // reaches fetch() at all; the rest of the URL is the one we built.
      // Strictly forward. A next-link that repeats or rewinds the offset would
      // otherwise fetch the same page for ever; PCO does not do that, which is
      // exactly why nothing would catch it if it started.
      const offset = nextOffset(json.links?.next);
      url = offset === null || offset <= seenOffset ? null : withOffset(url, offset);
      seenOffset = offset ?? seenOffset;
    }

    out.sort((a, b) => a.sequence - b.sequence);
    this.cacheSet(cacheKey, out, TTL_MEDIUM_MS);
    return out;
  }

  /** Scheduled service start times for a plan (ISO), earliest first — the
   *  time_type=service plan_times. Anchors the ScriptView projected clock. */
  async listPlanServiceTimes(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<string[]> {
    const times = await this.getPlanTimes(appId, secret, serviceTypeId, planId);
    return times
      .filter((t) => t.timeType === "service")
      .map((t) => t.startsAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
  }

  /** All rehearsal + service times for a plan (ISO starts/ends). Drives the
   *  time-aware reconnect scheduler (rehearsal = when gear comes on). */
  async listPlanTimes(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<{ type: string; startsAt: string; endsAt: string | null }[]> {
    const times = await this.getPlanTimes(appId, secret, serviceTypeId, planId);
    return times
      .filter((t) => t.timeType === "service" || t.timeType === "rehearsal")
      .map((t) => ({ type: t.timeType, startsAt: t.startsAt, endsAt: t.endsAt }));
  }

  /** The organization's IANA time zone (e.g. "America/Chicago"), used to render
   *  projected clock times in the plan's local time rather than the viewer's. */
  async listOrgTimeZone(appId: string, secret: string): Promise<string | null> {
    const cacheKey = `org-tz:${appId}`;
    const cached = this.cacheGet<string>(cacheKey);
    if (cached) return cached;

    const json = await this.request(PCO_BASE, appId, secret).catch(() => null);
    const data = json && !Array.isArray(json.data) ? json.data : null;
    const tz = data && typeof data.attributes.time_zone === "string" ? data.attributes.time_zone : null;
    if (tz) this.cacheSet(cacheKey, tz, TTL_LONG_MS);
    return tz;
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
    countdownTarget: "plan-start" | "service-time" = "plan-start",
  ): Promise<PcoLiveDTO> {
    const serverNow = new Date().toISOString();
    const base = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}`;
    const json = await this.request(`${base}/live?include=items,current_item_time`, appId, secret);
    const live = (Array.isArray(json.data) ? json.data[0] : json.data) as PcoNode | undefined;
    const included = json.included ?? [];

    // The chosen "service" plan_time occurrence (e.g. 9am vs 11am). Resolved in
    // EVERY mode (cached LONG) so it can (a) supply the pre-service countdown target
    // and (b) let SPL history separate back-to-back services that share one plan.
    const planTimes = await this.getPlanTimes(appId, secret, serviceTypeId, planId);
    const serviceTime = this.pickServiceTime(planTimes.filter((t) => t.timeType === "service"));
    const serviceTimeId = serviceTime?.id ?? null;
    const serviceTimeStartsAt = serviceTime?.startsAt ?? null;

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

    // Current/next item titles follow the PCO PLAN order (authoritative), not the
    // ProPresenter playlist — so an off-plan presentation can't leak a wrong "next".
    // listPlanItems is cached, so this is essentially free on most live ticks.
    const planItems = await this.listPlanItems(appId, secret, serviceTypeId, planId).catch(() => []);
    const { currentItemTitle, nextItemTitle } = resolvePlanCurrentNext(planItems, itemId);
    // Item clock for the automation engine (PCO puts no time on an Item). Built
    // from the already-cached rundown and plan times, so it costs no extra request.
    // A plan_time named after an item pins that item exactly; the rest are derived.
    const itemSchedule = scheduleItems(
      planItems,
      serviceTimeStartsAt,
      planTimes.flatMap((t) => (t.name ? [{ name: t.name, startsAt: t.startsAt }] : [])),
    );
    // Rehearsal + service times for the time-relative automation triggers. Carried
    // in every mode below: "an hour before rehearsal" has to fire when nothing is
    // live, which is most of the week.
    const planTimesDto = planTimes
      .filter((t) => t.timeType === "service" || t.timeType === "rehearsal")
      .map((t) => ({ id: t.id, name: t.name, timeType: t.timeType, startsAt: t.startsAt }));

    if (it && typeof liveStartAt === "string" && liveStartAt && itemNode) {
      // "Full Item Length" = the *plan item's* length (ItemTime.length is often 0)
      // plus any live length_offset the operator set.
      const planLen =
        typeof itemNode.attributes.length === "number" ? (itemNode.attributes.length as number) : 0;
      const offset =
        typeof it.attributes.length_offset === "number" ? it.attributes.length_offset : 0;
      const adjLen = planLen + offset;
      // Service-ended: the church marks the end with a "SERVICE END" header; once the
      // live controller reaches/passes it (operators park on a trailing buffer item
      // like "Stream Buffer"/"End of Service"), the service is over. Only trip on an
      // explicit end header — plans without one keep the normal "left item mode" end.
      const endIdx = planItems.findIndex((p) => p.itemType === "header" && isServiceEndHeader(p.title));
      const startIdx = planItems.findIndex((p) => p.itemType === "header" && isServiceStartHeader(p.title));
      const curIdx = planItems.findIndex((p) => p.id === itemId);
      const serviceEnded = endIdx >= 0 && curIdx >= 0 && curIdx >= endIdx;
      // Position-based (not time-based): items above the SERVICE START header are
      // pre-service (doors, pre-roll) — robust against early/late/storm-delayed starts.
      const beforeServiceStart = startIdx >= 0 && curIdx >= 0 && curIdx < startIdx;
      return {
        mode: "item",
        currentItemId: itemId,
        label: typeof itemNode.attributes.title === "string" ? itemNode.attributes.title : null,
        lengthSec: adjLen > 0 ? adjLen : null,
        liveStartAt,
        targetAt: null,
        serverNow,
        currentItemTitle,
        nextItemTitle,
        itemType: curIdx >= 0 ? (planItems[curIdx]?.itemType ?? null) : null,
        serviceTimeId,
        serviceTimeStartsAt,
        itemSchedule,
        planTimes: planTimesDto,
        serviceEnded,
        beforeServiceStart,
      };
    }

    // ── "preservice" mode: count down like PCO's green timer. ──
    // PCO's timer counts to the TOP of the plan (the first item), not the service
    // time — the "service time" is anchored at the service-start item, so pre-service
    // items above it (doors, pre-roll, …) run BEFORE it. When countdownTarget is
    // "plan-start" (default) we find a "service start"-type header and shift the
    // target earlier by the length of items above it, matching PCO. If there's no
    // such header (or countdownTarget is "service-time"), we count to the service
    // time. PCO's API exposes no per-item scheduled time or explicit anchor, so a
    // marker header is the only in-plan signal for where the service begins.
    if (serviceTimeStartsAt) {
      let targetAt = serviceTimeStartsAt;
      if (countdownTarget === "plan-start") {
        const startIdx = planItems.findIndex((p) => p.itemType === "header" && isServiceStartHeader(p.title));
        if (startIdx > 0) {
          const preSec = planItems.slice(0, startIdx).reduce((sum, p) => sum + (p.lengthSec || 0), 0);
          if (preSec > 0) targetAt = new Date(Date.parse(serviceTimeStartsAt) - preSec * 1000).toISOString();
        }
      }
      return {
        mode: "preservice",
        currentItemId: null,
        label: "Service starts",
        lengthSec: null,
        liveStartAt: null,
        targetAt,
        serverNow,
        currentItemTitle,
        nextItemTitle,
        serviceTimeId,
        serviceTimeStartsAt,
        itemSchedule,
        planTimes: planTimesDto,
      };
    }

    return {
      mode: "none",
      currentItemId: null,
      label: null,
      lengthSec: null,
      liveStartAt: null,
      targetAt: null,
      serverNow,
      currentItemTitle,
      nextItemTitle,
      serviceTimeId,
      serviceTimeStartsAt,
      itemSchedule,
      planTimes: planTimesDto,
    };
  }

  /**
   * Fetch + cache a plan's plan_times ONCE, for everything that needs them.
   *
   * The start countdown, the auto-rollover end, the derived item clock, the
   * ScriptView projected clock and the reconnect scheduler all read this one
   * list, fetched whole and filtered by the caller.
   *
   * "Once" was aspirational until this was the only fetch: three copies of the
   * same request lived here, under three cache keys, so a plan's times were
   * pulled three times over — and two of them asked for per_page=50 while the
   * comment on this one explains why 50 is not enough. A plan routinely carries
   * rehearsal, call, review and several service times, so the short page quietly
   * clipped the tail of the two lists that fed the ScriptView clock and the
   * reconnect scheduler.
   *
   * Cached LONG — plan times are effectively static day-of. The key carries the
   * appId as well as the plan: two orgs' credentials must not share an entry.
   */
  private async getPlanTimes(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<PlanTime[]> {
    const cacheKey = `plan-times:${appId}:${planId}`;
    const cached = this.cacheGet<PlanTime[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/plan_times?per_page=100`;
    const json = await this.request(url, appId, secret).catch(() => null);
    const raw = json && Array.isArray(json.data) ? json.data : [];
    const times = raw
      .map((t) => ({
        id: t.id,
        name: typeof t.attributes.name === "string" ? t.attributes.name : null,
        timeType: typeof t.attributes.time_type === "string" ? t.attributes.time_type : "",
        startsAt: typeof t.attributes.starts_at === "string" ? t.attributes.starts_at : null,
        endsAt: typeof t.attributes.ends_at === "string" ? t.attributes.ends_at : null,
      }))
      .filter((t): t is PlanTime => !!t.startsAt);

    this.cacheSet(cacheKey, times, json ? TTL_LONG_MS : TTL_FAILED_MS);
    return times;
  }

  /** Just the "service" occurrences (e.g. 9am vs 11am). */
  private async getServiceTimes(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<ServiceTime[]> {
    const times = await this.getPlanTimes(appId, secret, serviceTypeId, planId);
    return times.filter((t) => t.timeType === "service");
  }

  /**
   * Choose the relevant "service" time: the soonest that has not finished, else
   * the latest. (Same selection start + end always shared.)
   *
   * PCO only sets `ends_at` when a plan time was given a length, and plenty are
   * entered without one. The old test treated a missing end as "still upcoming",
   * which never went false — so on a Sunday with two end-less times the ascending
   * sort returned the 9am one all day. serviceTimeId feeds the
   * `${serviceTypeId}:${planId}:${serviceTimeId}` key in all three recorders, so
   * the 11am was recorded into the 9am's record: one merged curve, a peak spanning
   * both, and an attendance baseline never re-taken. That is precisely the
   * separation this field exists to provide.
   *
   * With no end time there is no direct signal that a service is over, but there
   * is an indirect one: a later service has begun. So an end-less time is finished
   * once any later-starting time has started. Where ends_at IS set it is used as
   * before, which stays more precise — the gap between one service ending and the
   * next beginning belongs to the next.
   */
  private pickServiceTime(services: ServiceTime[]): ServiceTime | null {
    return pickServiceTime(services);
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
