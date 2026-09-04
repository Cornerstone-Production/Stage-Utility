// sensource-service.ts — Polls the SenSource Vea people-counter API and
// broadcasts live counts on "people:count" for the dashboards + custom layouts.
//
// SenSource has no push/streaming endpoint, so we poll on an interval.
//
// HOW FAST, and why — measured against the live API during a Sunday arrival ramp
// (31 people/min entering, so the true count moved every second):
//
//   Vea's own numbers advance about every 78 seconds. At a 45s poll the count
//   changed on only 60% of polls, and the gap between changes was exactly one
//   poll (30%) or two (70%) — the signature of sampling a ~78s source at 46s.
//
// So the upstream refresh is the floor, but our poll interval is NOT free on top
// of it: it lands uniformly in [0, interval) after each upstream tick. At 45s
// that was a mean 23s / worst 46s of staleness we added ourselves, which is
// exactly why the Vea web dashboard read ahead of us. At 15s it is a mean 7.5s /
// worst 15s. Below ~10s the return collapses — the source only moves every 78s —
// so MIN_POLL_SECONDS stays there.
//
// A poll's requests all go out together for the same reason: at this cadence a
// serial chain of round-trips is a real share of the interval.
//
// BUILDING TOTAL — from the authoritative "space" occupancy endpoint when a space
// exists (this is what the Vea dashboard's "Most Recent Occupancy" reflects, and
// it's inherently scoped to the building so it can't include unrelated zones):
//   attendance = Σ space.sumins today        (how many entered)
//   occupancy  = Σ space.(sumins − sumouts)  (in the room now, clamped ≥0)
// The day-net equals the live occupancy at the same instant (verified against the
// website), and our poll is fresher than the dashboard tile. If a site has no
// spaces, we fall back to deriving the same from per-zone traffic.
//
// PER-ZONE breakdown — from /data/traffic (entityType=zone), summed per zone and
// narrowed CLIENT-SIDE to the selected zones (the API has no working zone filter).
//
// DAY AGGREGATES are the other half of the total (today's peak/min/avg and the
// configured capacity). When that request fails, the last good set is carried
// forward for up to ten minutes rather than published as null — a Vea 401 on
// alternating polls made every peak/avg/capacity tile flash a dash every other
// poll, and the peak of a day does not become unknown because one request was
// rejected.
//
// They are NOT cached between polls. Caching them for a minute was tried and
// removed: the same response carries today's ATTENDANCE, which moves by ~31
// people a minute on an arrival ramp, so freezing it to save four requests made
// the headline number worse than the thing it was saving.
//
// Auth is transparent to the operator: they enter an API client id + secret
// (created in the Vea app). We exchange those for a short-lived Bearer token via
// the documented client-credentials call and refresh it before expiry. A
// directly-pasted long-lived token is also accepted (skips the exchange).
//
// ONE API CLIENT PER INSTANCE. Vea appears to keep a single live token per API
// client: minting a new one invalidates the last. Two Stage instances sharing a
// client therefore knock each other offline, and the old "rejected → mint again"
// reflex made that a loop — each 401 minted a token that 401d the other side,
// until Vea answered 429 to the exchange itself. Measured in production, the two
// instances' 401s alternating minute by minute. So a rejection here is retried
// on the SAME token, a new one is minted no more than once per MIN_EXCHANGE_GAP_MS,
// a 429 is honoured, and a token rejected seconds after issue says so on the log
// with the fix (a second API client) named.

import { appTimeZone, zonedDateKey } from "./app-timezone.js";
import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import type { PeopleCountDTO, PeopleHistoryPoint, PeopleZoneCount } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { StatusIntegration } from "./integration-base.js";


const AUTH_URL = "https://auth.sensourceinc.com/oauth/token";
const API_BASE = "https://vea.sensourceinc.com/api";
const REQUEST_TIMEOUT_MS = 15000;
/** Refresh the token this far before it actually expires. */
const TOKEN_SKEW_MS = 60_000;
/** Poll cadence while something is watching, and the floor the poller enforces.
 *  Exported because the settings descriptor and the config reader must offer the
 *  same numbers: a form advertising a default the poller does not use gives an
 *  operator who never opened the panel a different rate from the one shown. */
export const DEFAULT_POLL_SECONDS = 15;
export const MIN_POLL_SECONDS = 10;
/** Rolling trend buffer size — ~3h at HISTORY_MIN_GAP_MS spacing. */
const HISTORY_CAP = 240;
/**
 * Minimum spacing between trend-buffer samples.
 *
 * Deliberately NOT the poll interval. The buffer is a multi-hour trend graph, so
 * pinning its resolution to the poll rate means dropping the interval silently
 * shortens the graph: the same 240 points that covered three hours at a 45s poll
 * cover one hour at 15s, and the people-graph loses two thirds of its history
 * with nothing anywhere reporting a fault. Attendance is a slow curve; 45s of
 * resolution is what it was drawn at and all it needs.
 */
const HISTORY_MIN_GAP_MS = 45_000;
/** Poll rate when no display is watching the people count. The configured rate
 *  is for a live service; between them nobody is reading it. */
const IDLE_POLL_MS = 60_000;
/** How stale a carried-forward set of day aggregates may get before the poll
 *  publishes nulls instead. Long enough to ride out a run of rejected requests,
 *  short enough that a display never shows a peak from a different hour. */
const DAY_AGGREGATE_STALE_MS = 10 * 60_000;
/** Pause before re-issuing a request Vea answered with 401. */
const RETRY_401_DELAY_MS = 500;
/** A token rejected sooner than this after it was minted did not expire —
 *  something else invalidated it. See noteSharedClientSuspicion. */
const FRESH_TOKEN_MS = 60_000;
/** Floor between two client-credentials exchanges, whatever else happens. This
 *  is the hard stop on the mint/invalidate loop two instances sharing one API
 *  client fall into: neither can ask faster than this however often it is
 *  rejected. */
const MIN_EXCHANGE_GAP_MS = 30_000;
/** How long to hold off the exchange after a 429 that names no Retry-After.
 *  Longer than the poll, so the next poll cannot simply ask again. */
const EXCHANGE_RATE_LIMIT_MS = 60_000;
/** Ceiling on a Retry-After we will honour. */
const RETRY_AFTER_MAX_MS = 15 * 60_000;
/** The shared-API-client warning describes a condition that lasts until an
 *  operator changes something, so it is written at most this often. */
const SHARED_CLIENT_LOG_GAP_MS = 60 * 60_000;

/** HTTP 401 and friends, carrying the status and body so a caller can tell an
 *  auth rejection from a network fault without parsing the message. */
class SenSourceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
    /**
     * WHICH token this request carried — the mint generation, 0 for a static
     * token or none. Deliberately the generation and not the token string: this
     * object reaches errorMessage() and the LAN-visible /log, and a credential
     * in an Error is one careless interpolation away from being published. The
     * caller only needs to know whether the token that failed is still the one
     * in hand, and a counter answers that.
     */
    readonly tokenId = 0,
  ) {
    super(`SenSource ${path} → HTTP ${status}`);
    this.name = "SenSourceHttpError";
  }
}

/** A Retry-After header in ms, from either form (delta-seconds or an HTTP date),
 *  clamped to RETRY_AFTER_MAX_MS. Null when absent or unparseable — the caller
 *  has its own floor. The clamp is not paranoia about Vea: a Retry-After of a
 *  day, or a date read from a box whose clock is wrong, would take the people
 *  count off the air for the rest of the service with nothing to do about it. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_MAX_MS);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_MAX_MS) : null;
}

/** The 401 in a settled result, or null — the shape the poll's token verdict is
 *  read from. Anything else (a 500, a timeout, a success) is not a token fact. */
function as401(r: PromiseSettledResult<unknown>): SenSourceHttpError | null {
  if (r.status !== "rejected") return null;
  return r.reason instanceof SenSourceHttpError && r.reason.status === 401 ? r.reason : null;
}

/** HH:MM:SS in the APP time zone. The production box runs UTC, so a host-clock
 *  time in a log line is one no operator can match to their morning. */
function clockOf(ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: appTimeZone(),
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ms));
  } catch {
    // An unusable zone must not cost the log line it was decorating.
    return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
  }
}

const OFFLINE: PeopleCountDTO = {
  connected: false,
  updatedAt: null,
  total: { attendance: null, occupancy: null },
  zones: [],
};

export interface SenSourceConfig {
  clientId: string | null;
  clientSecret: string | null;
  /** Optional static token — used directly if present, skipping the exchange. */
  apiToken: string | null;
  pollSeconds: number;
  /** Restrict to a single location (null = all the client can see). */
  locationId: string | null;
  /** Restrict to specific zones (empty = all zones for the location). */
  zoneIds: string[];
}

interface VeaLocation {
  locationId: string;
  name: string;
}

export interface VeaZone {
  zoneId: string;
  name: string;
  /** Parent location, resolved via sensor→site→location (zones carry no locationId). */
  locationId: string | null;
}

export interface VeaSpace {
  spaceId: string;
  name: string;
  /** Parent location (spaces DO carry locationId — used to scope by location). */
  locationId: string | null;
  /** Configured maximum capacity for the space (for the % of capacity metric). */
  maxCapacity: number | null;
}

export interface SpaceOccupancy {
  /** Building "in the room now" = Σ(sumins − sumouts) over the spaces, clamped ≥0. */
  occupancy: number;
  /** Building "entered today" = Σ sumins. */
  attendance: number;
  /** Today's peak occupancy across the spaces (Vea's authoritative max). */
  peak: number;
  /** Today's lowest occupancy across the spaces. */
  min: number;
  /** Today's mean occupancy (Σ per-space avg — exact for one space). */
  avg: number;
  /** How many space rows contributed (0 → caller should fall back to zone traffic). */
  spaces: number;
}

/** Coerce a number OR a numeric string (Vea returns avgoccupancy as a string). */
function numLoose(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Net the space-occupancy rows into a building total. `allow` (space ids) scopes
 *  client-side; empty/undefined sums every returned space. peak/min/avg are summed
 *  across spaces (exact for a single space — the common case; an approximation for
 *  multiple spaces since per-space extrema occur at different times). Exported for tests. */
export function reduceSpaceOccupancy(rows: unknown[], allow?: Set<string> | null): SpaceOccupancy {
  let ins = 0;
  let outs = 0;
  let peak = 0;
  let min = 0;
  let avg = 0;
  let spaces = 0;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const id = typeof row.spaceId === "string" ? row.spaceId : typeof row.entityId === "string" ? row.entityId : null;
    if (!id) continue;
    if (allow && allow.size > 0 && !allow.has(id)) continue;
    ins += num(row.sumins) ?? 0;
    outs += num(row.sumouts) ?? 0;
    peak += num(row.maxoccupancy) ?? 0;
    min += num(row.minoccupancy) ?? 0;
    avg += numLoose(row.avgoccupancy) ?? 0;
    spaces++;
  }
  return {
    occupancy: Math.max(0, Math.round(ins - outs)),
    attendance: Math.max(0, Math.round(ins)),
    peak: Math.max(0, Math.round(peak)),
    min: Math.max(0, Math.round(min)),
    avg: Math.max(0, Math.round(avg)),
    spaces,
  };
}

/** Vea's *live* tracked occupancy = the newest minute bucket per space, summed
 *  (each clamped ≥0). This matches the Vea dashboard's "Most Recent Occupancy",
 *  which clamps every sensor at ≥0 — so a door that logs more exits than entries
 *  never drives the room negative. The day-net Σins−Σouts DOES go negative on such
 *  a door, under-counting a multi-door room (one room, many entrances). `allow`
 *  (space ids) scopes client-side. Returns null when no usable minute row exists so
 *  the caller can fall back to the day-net. Exported for tests. */
export function latestSpaceOccupancy(rows: unknown[], allow?: Set<string> | null): number | null {
  // Keep the newest row per space (don't assume the API returns them sorted).
  const latest = new Map<string, { t: string; occ: number }>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const id = typeof row.spaceId === "string" ? row.spaceId : typeof row.entityId === "string" ? row.entityId : null;
    if (!id) continue;
    if (allow && allow.size > 0 && !allow.has(id)) continue;
    const t =
      typeof row.recordDate_minute_1 === "string"
        ? row.recordDate_minute_1
        : typeof row.recordDate === "string"
          ? row.recordDate
          : "";
    const occ = num(row.maxoccupancy) ?? numLoose(row.avgoccupancy) ?? 0;
    const cur = latest.get(id);
    if (!cur || t > cur.t) latest.set(id, { t, occ });
  }
  if (latest.size === 0) return null;
  let sum = 0;
  for (const v of latest.values()) sum += Math.max(0, v.occ);
  return Math.max(0, Math.round(sum));
}

/** Vea's static + occupancy endpoints wrap rows in `{ results: [...] }`, but a few
 *  (older /location responses) return a bare array. Tolerate both. */
function asRows(data: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)
      ? (data as { results: unknown[] }).results
      : [];
  return arr.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

/** Probe the handful of field names Vea has used for a zone's parent location. */
function probeLocationId(z: Record<string, unknown>): string | null {
  const direct = z.locationId ?? z.location_id ?? z.parentId ?? z.parent_id;
  if (typeof direct === "string" && direct) return direct;
  const nested = z.location;
  if (nested && typeof nested === "object") {
    const id = (nested as Record<string, unknown>).locationId ?? (nested as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/** Zone-list cache TTL — zones change rarely, the poll runs every ~45s. */
const ZONES_TTL_MS = 5 * 60_000;

export interface ReducedTraffic {
  zones: PeopleZoneCount[];
  /** Raw building-wide sums across all zones (for the correct total occupancy). */
  totalIns: number;
  totalOuts: number;
}

/** Sum a day's traffic rows into per-zone attendance/occupancy + building totals.
 *  Tolerant of both the detailed (`ins`/`outs`) and grouped (`sumins`/`sumouts`)
 *  response shapes, and of rows that omit the zone name. When `allow` is given,
 *  only those zone ids contribute — this is how scoping is enforced, since the Vea
 *  `/data/traffic` endpoint has no working location/zone filter param (we always
 *  request every zone and narrow client-side). Exported for unit tests. */
export function reduceTraffic(rows: unknown[], allow?: Set<string> | null): ReducedTraffic {
  const byZone = new Map<string, { name: string; ins: number; outs: number }>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const id =
      typeof row.zoneId === "string"
        ? row.zoneId
        : typeof row.entityId === "string"
          ? row.entityId
          : null;
    if (!id) continue;
    if (allow && allow.size > 0 && !allow.has(id)) continue;
    const ins = num(row.sumins) ?? num(row.ins) ?? 0;
    const outs = num(row.sumouts) ?? num(row.outs) ?? 0;
    const name = typeof row.name === "string" && row.name ? row.name : null;
    const cur = byZone.get(id) ?? { name: id, ins: 0, outs: 0 };
    cur.ins += ins;
    cur.outs += outs;
    if (name) cur.name = name;
    byZone.set(id, cur);
  }
  let totalIns = 0;
  let totalOuts = 0;
  const zones = [...byZone.entries()].map(([id, z]) => {
    totalIns += z.ins;
    totalOuts += z.outs;
    return {
      id,
      name: z.name,
      attendance: Math.max(0, Math.round(z.ins)),
      // Per-zone net (for single-zone objects). The BUILDING total is computed
      // from raw sums below — NOT by summing these clamped per-zone values, which
      // would over-count when people enter one door and leave another.
      occupancy: Math.max(0, Math.round(z.ins - z.outs)),
    };
  });
  return { zones, totalIns, totalOuts };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function buildDto(reduced: ReducedTraffic, updatedAt: string): PeopleCountDTO {
  // Building totals from RAW sums: occupancy nets entries against exits across all
  // zones (so a multi-door room reads ~0 when everyone who entered has left),
  // clamped ≥0 once at the building level. Attendance = total entries today.
  const attendance = Math.max(0, Math.round(reduced.totalIns));
  const occupancy = Math.max(0, Math.round(reduced.totalIns - reduced.totalOuts));
  // peak/min/avg are only available from the space endpoint (the poll overrides
  // total when a space exists); the zone-traffic fallback leaves them null.
  return {
    connected: true,
    updatedAt,
    total: { attendance, occupancy, peak: null, min: null, avg: null, capacity: null },
    zones: reduced.zones,
  };
}

class SenSourceService extends StatusIntegration<PeopleCountDTO> {
  private cfg: SenSourceConfig | null = null;

  private token: string | null = null;
  private tokenExpiresAt = 0;
  /**
   * In-flight client-credentials exchange, shared by concurrent callers.
   *
   * A poll issues its requests together and every one of them asks for an auth
   * header, so the first poll after a token expiry would otherwise send several
   * simultaneous exchanges to the OAuth endpoint, each overwriting the other's
   * token. Same shape secretsStore uses for its concurrent decrypt.
   */
  private authInFlight: Promise<string> | null = null;

  private lastCountSig: string | null = null;
  /** Rolling building-total samples for the people-graph trend object. */
  private history: PeopleHistoryPoint[] = [];
  /** Cached /zone listing for location→zone scoping (see cachedZones). */
  private zonesCache: { at: number; zones: VeaZone[] } | null = null;
  /** Cached /space listing for the authoritative building occupancy. */
  private spacesCache: { at: number; spaces: VeaSpace[] } | null = null;
  /** The last day aggregates that reached a display, kept so a failing request
   *  degrades to "a minute old" rather than to a row of dashes. */
  private carriedDay: {
    peak: number;
    min: number;
    avg: number;
    capacity: number | null;
    /** The SPACE-derived attendance published with these aggregates. */
    attendance: number;
    /** The ZONE-derived attendance at that same moment. The pair is what makes a
     *  degraded poll continuous: the space count advanced by the doors' delta
     *  since, rather than swapped for a zone total that counts other doors. */
    zoneAttendance: number;
    at: number;
    /** The app-time-zone calendar date these belong to. Carrying a peak across
     *  midnight would publish yesterday's busiest minute as today's. */
    dateKey: string;
  } | null = null;
  /**
   * Which parts of the poll are currently degraded, keyed by name.
   *
   * Both of this file's partial failures — the day aggregates and the live
   * minute series — used to write a console line on EVERY poll they failed on,
   * which at 15s is 240 identical records an hour on a LAN-visible /log. A map
   * rather than a flag each, so the third one cannot be written without the
   * once-per-transition rule already attached to it.
   */
  private degraded = new Map<string, boolean>();
  /** When the current token was minted — a token rejected seconds after issue is
   *  a different fault from one that expired. See noteSharedClientSuspicion. */
  private tokenIssuedAt = 0;
  /**
   * How many tokens have been minted. Identifies the token a request carried
   * without carrying the token itself — see SenSourceHttpError.tokenId.
   *
   * 0 means no minted token has ever been held, so a 401 quoting 0 is either a
   * static token or a token already replaced since.
   */
  private tokenGen = 0;
  /** When the last client-credentials exchange was STARTED (not finished). */
  private lastExchangeAt = 0;
  /** No exchange before this instant — set from a 429's Retry-After. */
  private exchangeBlockedUntil = 0;
  /** Last time the shared-API-client warning was written. */
  private lastSharedClientLogAt = 0;
  /**
   * Which configuration the current poll belongs to, bumped by configure().
   *
   * A poll is several round-trips long, and configure() can land in the middle
   * of one — an operator changing the location, or clearing the credentials. The
   * requests already in flight were scoped by the OLD config, so publishing
   * their answer writes counts for a location nobody selected, and carrying
   * their aggregates keeps that scope alive for ten more minutes.
   */
  private pollEpoch = 0;
  // addDemandSource / inDemand now live on StatusIntegration.
  //
  // They were written here first, for the same failure the SPL channel then hit
  // independently: the idle gate below asked only `channelHasSubscribers`, a
  // browser question, while the attendance recorder and tslService consume counts
  // in-process and are invisible to it. On a Sunday with no people-count display
  // open the recorder sampled counts up to a minute stale for the whole service,
  // and the graph it drew was the shape of the poll gate rather than of the room.
  //
  // Second instance, so the shape moved to the base class rather than being
  // copied — see integration-base.ts.

  /** True while the pending poll was scheduled at the slow idle cadence. */
  private polledIdle = false;

  /** When the trend buffer last took a sample. Its own clock, not the poll's. */
  private lastHistoryAt = 0;

  /**
   * Add a building-total sample to the rolling trend buffer, no more often than
   * HISTORY_MIN_GAP_MS.
   *
   * The gate is a floor, not a ceiling: an operator who polls every five minutes
   * still gets a point every five minutes. It only stops a fast poll from
   * spending the fixed 240-point buffer on minutes instead of hours.
   *
   * Spacing is measured between the timestamps actually stored, not wall-clock
   * call times, so the gate and the graph agree on what "45s apart" means.
   */
  private appendHistory(dto: PeopleCountDTO): void {
    const parsed = Date.parse(dto.updatedAt ?? "");
    const at = Number.isFinite(parsed) ? parsed : Date.now();
    if (at - this.lastHistoryAt < HISTORY_MIN_GAP_MS) return;
    this.lastHistoryAt = at;
    this.history.push({
      t: dto.updatedAt!,
      attendance: dto.total.attendance ?? 0,
      occupancy: dto.total.occupancy ?? 0,
    });
    if (this.history.length > HISTORY_CAP) this.history.splice(0, this.history.length - HISTORY_CAP);
  }

  /**
   * Something started needing counts — poll now rather than finishing the wait.
   *
   * The idle gate decides the cadence at the END of each poll, so a consumer
   * appearing just after one was scheduled waits out the full idle minute. That
   * is exactly what happens at the start of a service: the recorder opens its
   * record on a live tick, and the first sample of the pre-service arrival ramp
   * — the steepest part of the curve, and the part an operator watches — could
   * be up to a minute stale, with the graph drawing a flat lead-in that never
   * happened.
   *
   * Only pre-empts an IDLE wait. A poll already scheduled at the service
   * cadence is close enough, and cancelling it would let a flapping consumer
   * poll faster than the operator's configured rate — the thing the gate's
   * `Math.max` exists to prevent.
   */
  pollNowIfIdle(): void {
    if (!this.running || !this.polledIdle || !this.inDemand) return;
    this.polledIdle = false;
    console.log("[sensource] a consumer arrived — polling now rather than waiting out the idle interval");
    this.scheduleIn(0);
  }

  constructor() {
    super("sensource", "people:count", OFFLINE);
  }

  /** Polls on a fixed interval rather than reconnecting with back-off, so the
   *  base's retry timer is unused here — connect() is one poll. */
  protected get configured(): boolean {
    return !!this.cfg && (!!this.cfg.apiToken || (!!this.cfg.clientId && !!this.cfg.clientSecret));
  }

  configure(cfg: SenSourceConfig): void {
    this.cfg = cfg;
    this.resetAuth();
    this.resetReport();
    this.zonesCache = null;
    this.spacesCache = null;
    this.carriedDay = null;
    this.degraded.clear();
    // New credentials — nothing learned about the old ones survives, including
    // the exchange rate-limit state.
    this.lastExchangeAt = 0;
    this.exchangeBlockedUntil = 0;
    this.lastSharedClientLogAt = 0;
    // Anything already in flight belongs to the configuration it was issued
    // under, and stops here.
    this.pollEpoch++;
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    const sec = Math.max(MIN_POLL_SECONDS, this.cfg?.pollSeconds || DEFAULT_POLL_SECONDS);
    console.log(`[sensource] polling every ${sec}s`);
    // The cadence rides the base class's single timer — connect() re-arms it. A
    // second setInterval here was exactly what integration-base warns against
    // ("two timers would double the poll rate after a reconnect"), and it also
    // meant this integration had NO back-off at all: a dead Vea API was re-hit at
    // full rate forever, it polled at service rate all week instead of going
    // dormant, and it logged every single failure.
    super.start(); // runs the first poll, which schedules the next
  }

  protected override teardown(): void {
    /* nothing to tear down: the base class owns the only timer */
  }

  /** One-shot reachability check for the Integrations "Test connection" button. */
  async test(cfg: SenSourceConfig): Promise<{ ok: boolean; message?: string }> {
    try {
      const prev = this.cfg;
      this.cfg = cfg;
      this.resetAuth();
      try {
        const locations = await this.listLocations();
        return { ok: true, message: `Authenticated — ${locations.length} location(s) visible` };
      } finally {
        this.cfg = prev;
        this.resetAuth();
      }
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /** List locations using a given config without disturbing a running poller —
   *  if already configured (same creds), reuse the live cfg + token. */
  async listLocationsWith(cfg: SenSourceConfig): Promise<VeaLocation[]> {
    if (this.cfg) return this.listLocations();
    const prev = this.cfg;
    this.cfg = cfg;
    try {
      return await this.listLocations();
    } finally {
      this.cfg = prev;
      this.resetAuth();
    }
  }

  /** List the locations the client can see (backs the settings picker). */
  async listLocations(): Promise<VeaLocation[]> {
    const data = await this.apiGet<unknown>("/location");
    return asRows(data)
      .map((l) => ({
        locationId: String(l.locationId ?? l.id ?? ""),
        name: typeof l.name === "string" ? l.name : String(l.locationId ?? ""),
      }))
      .filter((l) => l.locationId);
  }

  /** List the zones the client can see (backs the zone multi-select + scoping).
   *  Zones carry no locationId, so resolve it via zone→sensor→site→location.
   *  The sensor/site joins are best-effort: if either fails, locationId is null
   *  (the zone still lists; the user can scope it manually). */
  async listZones(): Promise<VeaZone[]> {
    const [zoneData, sensorSite, siteLoc] = await Promise.all([
      this.apiGet<unknown>("/zone"),
      this.sensorToSite(),
      this.siteToLocation(),
    ]);
    return asRows(zoneData)
      .map((z) => {
        const sensorId = typeof z.sensorId === "string" ? z.sensorId : null;
        const siteId = sensorId ? sensorSite.get(sensorId) ?? null : null;
        const locationId = (siteId ? siteLoc.get(siteId) : null) ?? probeLocationId(z);
        return {
          zoneId: String(z.zoneId ?? z.entityId ?? z.id ?? ""),
          name: typeof z.name === "string" && z.name ? z.name : String(z.zoneId ?? ""),
          locationId,
        };
      })
      .filter((z) => z.zoneId);
  }

  private async sensorToSite(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try {
      for (const s of asRows(await this.apiGet<unknown>("/sensor"))) {
        if (typeof s.sensorId === "string" && typeof s.siteId === "string") m.set(s.sensorId, s.siteId);
      }
      this.degradationChanged("sensor-join", false);
    } catch (err) {
      // Once per transition. This ran on every poll of an outage, like the four
      // others in this file.
      if (this.degradationChanged("sensor-join", true)) {
        console.warn(
          `[sensource] /sensor join failed (zones won't map to locations): ${scrub(errorMessage(err), 120)}`,
        );
      }
    }
    return m;
  }

  private async siteToLocation(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try {
      for (const s of asRows(await this.apiGet<unknown>("/site"))) {
        if (typeof s.siteId === "string" && typeof s.locationId === "string") m.set(s.siteId, s.locationId);
      }
      this.degradationChanged("site-join", false);
    } catch (err) {
      if (this.degradationChanged("site-join", true)) {
        console.warn(
          `[sensource] /site join failed (zones won't map to locations): ${scrub(errorMessage(err), 120)}`,
        );
      }
    }
    return m;
  }

  /** List the spaces the client can see (spaces back the authoritative building
   *  occupancy; they carry locationId so they scope cleanly by location). */
  async listSpaces(): Promise<VeaSpace[]> {
    const data = await this.apiGet<unknown>("/space");
    return asRows(data)
      .map((s) => ({
        spaceId: String(s.spaceId ?? s.entityId ?? s.id ?? ""),
        name: typeof s.name === "string" && s.name ? s.name : String(s.spaceId ?? ""),
        locationId: typeof s.locationId === "string" ? s.locationId : null,
        maxCapacity: num(s.maxCapacity) ?? num(s.capacity) ?? null,
      }))
      .filter((s) => s.spaceId);
  }

  /** List zones with a given config without disturbing a running poller. */
  async listZonesWith(cfg: SenSourceConfig): Promise<VeaZone[]> {
    if (this.cfg) return this.listZones();
    const prev = this.cfg;
    this.cfg = cfg;
    try {
      return await this.listZones();
    } finally {
      this.cfg = prev;
      this.resetAuth();
    }
  }

  /** Cached zone list (5-min TTL) — the poll resolves a location's zones from it
   *  without re-listing every tick. */
  private async cachedZones(): Promise<VeaZone[]> {
    const now = Date.now();
    if (this.zonesCache && now - this.zonesCache.at < ZONES_TTL_MS) return this.zonesCache.zones;
    const zones = await this.listZones();
    this.zonesCache = { at: now, zones };
    return zones;
  }

  /** Resolve the set of zone ids the building total should sum. Explicit zone
   *  selection wins; otherwise a selected location is mapped to its zones (when
   *  the API exposes the parent-location field); otherwise null = all zones. */
  private async resolveAllowedZones(): Promise<Set<string> | null> {
    const cfg = this.cfg;
    if (!cfg) return null;
    if (cfg.zoneIds.length) return new Set(cfg.zoneIds);
    if (cfg.locationId) {
      try {
        const ids = (await this.cachedZones())
          .filter((z) => z.locationId === cfg.locationId)
          .map((z) => z.zoneId);
        if (ids.length) {
          this.degradationChanged("zone-location-map", false);
          this.degradationChanged("zone-resolution", false);
          return new Set(ids);
        }
        // Once per transition, like the other two degradations in this file.
        // This ran on every poll of a misconfiguration — the third copy of the
        // same mistake, and the one an operator sees for weeks at a time.
        if (this.degradationChanged("zone-location-map", true)) {
          console.warn(
            "[sensource] a location is selected but no zones map to it (the API may not expose zone→location); counting all visible zones. Pick specific zones to scope reliably.",
          );
        }
      } catch (err) {
        if (this.degradationChanged("zone-resolution", true)) {
          console.warn(`[sensource] zone resolution failed; counting all zones: ${scrub(errorMessage(err), 120)}`);
        }
      }
    }
    return null;
  }

  /**
   * The /space listing, cached, and the ONE place its failure is reported.
   *
   * Three callers each swallowed a failure here into a fallback value —
   * "no spaces", "no scope", "no capacity" — so a listing endpoint answering 500
   * for an hour was indistinguishable from a site that simply has no spaces.
   * Reported here, once per transition, and rethrown: the callers still choose
   * their fallback, but none of them is the last thing to see the error.
   */
  private async cachedSpaces(): Promise<VeaSpace[]> {
    const now = Date.now();
    if (this.spacesCache && now - this.spacesCache.at < ZONES_TTL_MS) return this.spacesCache.spaces;
    try {
      const spaces = await this.listSpaces();
      this.spacesCache = { at: now, spaces };
      if (this.degradationChanged("space-listing", false)) {
        console.log("[sensource] the space listing is readable again");
      }
      return spaces;
    } catch (err) {
      if (this.degradationChanged("space-listing", true)) {
        console.warn(
          `[sensource] the space listing could not be read (${scrub(errorMessage(err), 120)}); ` +
            "the building total falls back to the zone-derived net and capacity is unknown",
        );
      }
      throw err;
    }
  }

  /** Which space ids the building total sums — the selected location's spaces, or
   *  all spaces. Spaces carry locationId, so this scopes cleanly. null = all. */
  private async resolveAllowedSpaces(): Promise<Set<string> | null> {
    const cfg = this.cfg;
    if (!cfg?.locationId) return null;
    try {
      const ids = (await this.cachedSpaces())
        .filter((s) => s.locationId === cfg.locationId)
        .map((s) => s.spaceId);
      return ids.length ? new Set(ids) : null;
    } catch {
      return null;
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Forget the cached token AND any exchange still in flight.
   *
   * Both halves: a reconfigure that dropped only the token would hand the next
   * caller one minted from the old credentials by an exchange already running.
   *
   * The 401 path deliberately does NOT use this any more — see apiGet. It reset
   * and re-minted inline, which is half of the loop two instances sharing one
   * API client fall into.
   */
  private resetAuth(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenIssuedAt = 0;
    this.authInFlight = null;
  }

  /**
   * Discard the token identified by `tokenId`, if it is still the one in hand.
   *
   * The guard is the point: the verdict on a token is reached after both of the
   * poll's requests have answered, by which time an ordinary expiry may already
   * have replaced it. Expiring unconditionally there would throw away a token
   * that has done nothing wrong.
   */
  private expireToken(tokenId: number): void {
    if (!this.token || tokenId !== this.tokenGen) return;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenIssuedAt = 0;
  }

  /** Age of the token `tokenId` names, or Infinity if that token is no longer
   *  the one in hand (nothing can be concluded about a token already replaced). */
  private tokenAgeMs(tokenId: number, now: number): number {
    if (tokenId === 0 || tokenId !== this.tokenGen || this.tokenIssuedAt === 0) {
      return Number.POSITIVE_INFINITY;
    }
    return now - this.tokenIssuedAt;
  }

  /**
   * How long the exchange must wait, in ms — 0 when it may go now.
   *
   * It applies to the poller and to the operator's Test connection alike. An
   * exemption for the button was tried and removed: it is a second way to mint,
   * and "the floor holds unless somebody is watching" is not a floor. The wait
   * is reported in the message, so a Test pressed inside the window says why.
   */
  private exchangeWaitMs(now = Date.now()): number {
    return Math.max(0, this.exchangeBlockedUntil - now, this.lastExchangeAt + MIN_EXCHANGE_GAP_MS - now);
  }

  private async authHeader(): Promise<string> {
    const cfg = this.cfg;
    if (!cfg) throw new Error("SenSource not configured");
    // Static token path — use directly.
    if (cfg.apiToken) {
      const t = cfg.apiToken.trim();
      return /^bearer\s/i.test(t) ? t : `Bearer ${t}`;
    }
    if (this.token && Date.now() < this.tokenExpiresAt) return `Bearer ${this.token}`;
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("Missing client id / secret");

    // One exchange at a time — the poll's parallel requests all land here, and
    // they JOIN one rather than each being judged by the gate below. Gating
    // first would fail every sibling of the request that started the exchange
    // with "wait 30s", losing the whole poll on the one path that is working.
    if (this.authInFlight) return this.authInFlight;

    // The exchange is rate-limited from this side as well as Vea's. Two Stage
    // instances sharing one API client invalidate each other's token on every
    // mint, so "rejected → mint again" is a loop that only ends when Vea answers
    // 429 — which is exactly what production did. Failing the poll here instead
    // lets the base class's back-off do its job.
    const wait = this.exchangeWaitMs();
    if (wait > 0) {
      throw new Error(`Auth deferred — ${Math.ceil(wait / 1000)}s before the next token request`);
    }

    this.lastExchangeAt = Date.now();
    this.authInFlight = this.exchangeToken(cfg.clientId, cfg.clientSecret).finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async exchangeToken(clientId: string, clientSecret: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Rethrown, not swallowed — but named, so "no network" is not reported to
      // the operator as a credentials problem.
      throw new Error(`could not reach Vea's token endpoint: ${scrub(errorMessage(err), 120)}`, {
        cause: err,
      });
    }
    if (res.status === 429) {
      // Vea rate-limits the exchange itself. Honour Retry-After when it sends
      // one; otherwise hold off a full minute, which is longer than the poll and
      // so guarantees the next poll does not simply ask again.
      const after = retryAfterMs(res.headers.get("retry-after"));
      const waitMs = Math.max(after ?? 0, EXCHANGE_RATE_LIMIT_MS);
      this.exchangeBlockedUntil = Date.now() + waitMs;
      if (this.degradationChanged("token-exchange", true)) {
        console.warn(
          `[sensource] the token exchange is rate-limited (HTTP 429); waiting ${Math.round(waitMs / 1000)}s. ` +
            "Two instances sharing one Vea API client will do this to each other — give each its own.",
        );
      }
      throw new Error(`Auth rate-limited (HTTP 429) — retrying in ${Math.round(waitMs / 1000)}s`);
    }
    if (!res.ok) {
      // "Check client id/secret" is advice, and it is only true for a refusal.
      // A 502 from the token endpoint is not the operator's credentials, and an
      // operator who re-types a correct secret because the log told them to has
      // been sent the wrong way by their own diagnostics.
      throw new Error(
        res.status === 401 || res.status === 403
          ? `Auth refused (HTTP ${res.status}) — check the client id and secret`
          : `Vea's token endpoint answered HTTP ${res.status}`,
      );
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Auth response had no access_token");
    if (this.degradationChanged("token-exchange", false)) {
      console.log("[sensource] the token exchange is answering again");
    }
    this.token = json.access_token;
    this.tokenIssuedAt = Date.now();
    this.tokenGen++;
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    this.tokenExpiresAt = Date.now() + Math.max(0, ttlMs - TOKEN_SKEW_MS);
    return `Bearer ${this.token}`;
  }

  /**
   * A token rejected within FRESH_TOKEN_MS of being minted is not an expiry —
   * it is somebody else minting on the same API client.
   *
   * Vea appears to keep one live token per client, so a second Stage instance
   * (a spare box, a laptop left running) using the same client id invalidates
   * this one the moment it authenticates, and each instance re-minting on
   * rejection invalidates the other's in turn. The pair storms the exchange
   * endpoint until Vea answers 429. Logged once an hour, because the condition
   * lasts as long as the second instance does and the fix is the operator's.
   */
  private noteSharedClientSuspicion(ageMs: number): void {
    const now = Date.now();
    if (now - this.lastSharedClientLogAt < SHARED_CLIENT_LOG_GAP_MS) return;
    this.lastSharedClientLogAt = now;
    console.warn(
      `[sensource] token rejected ${Math.round(ageMs / 1000)}s after issue — another instance may be ` +
        "using the same API client; each new token invalidates the last. Give each instance its own Vea API client.",
    );
  }

  /**
   * GET a Vea endpoint, retrying a 401 exactly once on the SAME token.
   *
   * This function decides nothing about the token's fate — not whether to
   * replace it, not whether somebody else is using the API client. It cannot:
   * it sees one request, and the poll's requests are issued together, so
   * anything decided here is decided on whichever response arrived first. That
   * is not a fact about the token. A fast 401 landing before a slow 200 on a
   * perfectly good token had a single instance re-minting every other poll and
   * accusing itself of being two.
   *
   * So it reports: the 401 is retried once (a transient edge rejection is real),
   * and if it stands the error carries the status, the body and WHICH token was
   * used. connect() reaches one verdict per poll, from every response together.
   *
   * `carry` is the retry's half: the resolved header and the token that earned
   * the first rejection are handed to the second attempt rather than derived
   * again. Deriving again meant a token expiring inside the 500ms pause was
   * re-minted by the retry, the failure was tagged with the NEW generation, and
   * the poll's verdict then read "a token minted moments ago was rejected" — a
   * shared-client accusation manufactured by the retry itself.
   */
  private async apiGet<T>(path: string, carry?: { auth: string; tokenId: number }): Promise<T> {
    const auth = carry?.auth ?? (await this.authHeader());
    const tokenId = carry?.tokenId ?? (this.cfg?.apiToken ? 0 : this.tokenGen);
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", Authorization: auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) {
      const body = await res.text().catch(() => "");
      if (!carry) {
        await new Promise((r) => setTimeout(r, RETRY_401_DELAY_MS));
        return this.apiGet<T>(path, { auth, tokenId });
      }
      // What Vea said, on the FIRST rejection of a run for this request. Keyed
      // by path AND query — the day and minute occupancy calls fail
      // independently — and cleared by that request's next success, so an outage
      // writes one line rather than one per distinct body. A body carrying a
      // timestamp made every poll "distinct", which was two lines a poll for as
      // long as it lasted.
      if (this.degradationChanged(`auth:${path}`, true)) {
        const snippet = scrub(body.replace(/\s+/g, " ").trim(), 120) || "(empty response body)";
        console.warn(`[sensource] HTTP 401 from ${path}: ${snippet}`);
      }
      throw new SenSourceHttpError(401, path, body, tokenId);
    }
    if (!res.ok) throw new SenSourceHttpError(res.status, path, "", tokenId);
    this.degradationChanged(`auth:${path}`, false);
    return (await res.json()) as T;
  }

  // ── Poll ──────────────────────────────────────────────────────────────────

  /** True only on the poll where `key` actually entered or left its degraded
   *  state, so the caller logs the transition and not the outage. */
  private degradationChanged(key: string, nowDegraded: boolean): boolean {
    if ((this.degraded.get(key) ?? false) === nowDegraded) return false;
    this.degraded.set(key, nowDegraded);
    return true;
  }

  /** Vea's live tracked occupancy — the newest per-minute bucket per space.
   *  Null when the minute series is unavailable, which leaves the caller on the
   *  day-net; the reason is logged once per outage, not once per poll. */
  private async liveOccupancy(allow: Set<string> | null): Promise<number | null> {
    const mParams = new URLSearchParams({
      relativeDate: "today",
      dateGroupings: "minute",
      entityType: "space",
      metrics: "occupancy(max)",
    });
    try {
      const body = await this.apiGet<{ results?: unknown[] }>(`/data/occupancy?${mParams.toString()}`);
      const live = latestSpaceOccupancy(body.results ?? [], allow);
      if (this.degradationChanged("minute-occupancy", false)) {
        console.log("[sensource] the live minute occupancy is available again");
      }
      return live;
    } catch (err) {
      if (this.degradationChanged("minute-occupancy", true)) {
        console.warn(
          `[sensource] live minute occupancy unavailable; using the day total: ${scrub(errorMessage(err), 120)}`,
        );
      }
      return null;
    }
  }

  /** Building capacity = Σ maxCapacity over the allowed spaces, or null when the
   *  space listing is unavailable. Null rather than a throw: a missing capacity
   *  must not cost the occupancy beside it, and the listing failure is already
   *  on the log through apiGet and the poll's own error handler. */
  private async spaceCapacity(allow: Set<string> | null): Promise<number | null> {
    try {
      const cap = (await this.cachedSpaces())
        .filter((s) => !allow || allow.size === 0 || allow.has(s.spaceId))
        .reduce((a, s) => a + (s.maxCapacity ?? 0), 0);
      return cap > 0 ? cap : null;
    } catch {
      return null;
    }
  }

  /** The poll's two data requests, issued together, both answers kept. */
  private pollPair(
    trafficPath: string,
    dayPath: string,
  ): Promise<
    [PromiseSettledResult<{ results?: unknown[] }>, PromiseSettledResult<{ results?: unknown[] }>]
  > {
    return Promise.allSettled([
      this.apiGet<{ results?: unknown[] }>(trafficPath),
      this.apiGet<{ results?: unknown[] }>(dayPath),
    ]) as Promise<
      [PromiseSettledResult<{ results?: unknown[] }>, PromiseSettledResult<{ results?: unknown[] }>]
    >;
  }

  /** Can a new token be minted at all? A pasted static token cannot be replaced
   *  from here, and neither can nothing. */
  private canMint(): boolean {
    return !this.cfg?.apiToken && !!this.cfg?.clientId && !!this.cfg?.clientSecret;
  }

  /** Does this site have space(s) in scope? From the /space listing, which is
   *  what actually knows. FALSE when the listing cannot be read: "have we ever
   *  carried a value" is the same wrong question that made a cold-start failure
   *  invisible, and the listing failure is reported by cachedSpaces. */
  private async siteHasSpaces(allow: Set<string> | null): Promise<boolean> {
    try {
      return (await this.cachedSpaces()).some(
        (sp) => !allow || allow.size === 0 || allow.has(sp.spaceId),
      );
    } catch {
      return false;
    }
  }

  /** Drop carried day aggregates once the app-time-zone date rolls over.
   *  Yesterday's peak published as today's is worse than no peak, and the
   *  ten-minute age check alone does not catch a restart-free midnight. */
  private dropCarriedAtMidnight(now: number): void {
    const key = zonedDateKey(now);
    if (!this.carriedDay || this.carriedDay.dateKey === key) return;
    console.log(`[sensource] the date rolled over to ${key}; dropping the carried day aggregates`);
    this.carriedDay = null;
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.cfg) return;
    const epoch = this.pollEpoch;
    let ok = false;
    try {
      // The Vea /data/traffic endpoint has NO working location/zone filter param
      // (locationIds/entityIds are silently ignored — confirmed against the public
      // API + every reference client), so we always request all zones for today
      // and narrow to the selected zones CLIENT-SIDE. excludeClosedHours matches
      // the reference clients (drops after-hours sensor noise).
      const params = new URLSearchParams({
        relativeDate: "today",
        dateGroupings: "day",
        entityType: "zone",
        metrics: "ins,outs",
        excludeClosedHours: "true",
      });

      // Day stats: attendance (Σ entries), peak/min/avg occupancy for the day.
      const oParams = new URLSearchParams({
        relativeDate: "today",
        dateGroupings: "day",
        entityType: "space",
        metrics: "occupancy(max),occupancy(min),occupancy(avg)",
      });

      // Nothing in this poll depends on anything else in it, so it all goes out
      // at once rather than in a chain. At the fast cadence a serial round-trip
      // is a tenth of the interval, and every millisecond of it is staleness
      // added on top of Vea's own ~78s refresh. The zone and space listings are
      // usually cache hits, but on a cold cache they are round-trips too.
      //
      // allSettled, not all: the two failures are not alike. Losing traffic
      // loses the poll; losing the day aggregates only costs peak/min/avg until
      // the carried set is too old. And the PAIR is what the token verdict is
      // read from — see below — which is only possible if both answers survive.
      const now = Date.now();
      this.dropCarriedAtMidnight(now);
      const trafficPath = `/data/traffic?${params.toString()}`;
      const dayPath = `/data/occupancy?${oParams.toString()}`;
      let [allow, allowSpaces, [trafficRes, dayRes]] = await Promise.all([
        this.resolveAllowedZones(),
        this.resolveAllowedSpaces(),
        this.pollPair(trafficPath, dayPath),
      ]);

      // ONE verdict on the token, per poll, from both responses together.
      //
      // Everything on this token was rejected, so this is the token and not an
      // endpoint. (One 401 beside one 200 is the endpoint's problem and is left
      // to the carry-forward path below, whichever order they arrived in.)
      const dead = as401(trafficRes) && as401(dayRes) ? as401(trafficRes) : null;
      if (dead) {
        const ageMs = this.tokenAgeMs(dead.tokenId, now);
        if (ageMs < FRESH_TOKEN_MS) {
          // Minted seconds ago and already rejected: somebody else is minting on
          // this API client. Do not mint back — that is the loop. Drop it, say
          // so, and let the base class back off.
          this.noteSharedClientSuspicion(ageMs);
          this.expireToken(dead.tokenId);
          throw dead;
        }
        if (this.canMint()) {
          // An ordinary rollover. Replace the token and run the pair once more,
          // so a token reaching its end costs a display nothing.
          this.expireToken(dead.tokenId);
          [trafficRes, dayRes] = await this.pollPair(trafficPath, dayPath);
        }
      }
      // Traffic is the poll. Its failure — 401 or anything else — ends it here,
      // through the error path that reports and backs off.
      if (trafficRes.status === "rejected") throw trafficRes.reason;
      const traffic = trafficRes.value;
      const dayOcc = dayRes.status === "fulfilled" ? dayRes.value : null;
      const dayOccErr: unknown = dayRes.status === "rejected" ? dayRes.reason : null;
      const reduced = reduceTraffic(traffic.results ?? [], allow);
      const dto = buildDto(reduced, new Date().toISOString());
      // Today's entries as the DOORS saw them. Kept beside the space-derived
      // count, never silently substituted for it — see the carry below.
      const zoneAttendance = dto.total.attendance ?? 0;

      // This poll's day aggregates, or nothing if the request was rejected.
      const day = dayOcc ? reduceSpaceOccupancy(dayOcc.results ?? [], allowSpaces) : null;
      const spaces = day?.spaces ?? 0;
      // Does this site have spaces at all? From the /space listing, which is the
      // authority. Asking "have we carried any?" instead meant a cold start
      // whose FIRST day request failed concluded the site had none, took the
      // zone-net path, and logged nothing whatsoever — the failure was invisible
      // and the error object was discarded unread.
      const hasSpaces = spaces > 0 || (await this.siteHasSpaces(allowSpaces));
      const carried =
        this.carriedDay && now - this.carriedDay.at < DAY_AGGREGATE_STALE_MS ? this.carriedDay : null;

      // The day-aggregate verdict is logged HERE, before anything is built from
      // it, so the failure is reported whether or not this site has spaces.
      const dayReason = !dayOccErr
        ? spaces === 0 && hasSpaces
          ? "the response listed no spaces"
          : null
        : dayOccErr instanceof SenSourceHttpError
          ? `HTTP ${dayOccErr.status}`
          : scrub(errorMessage(dayOccErr), 120);
      if (dayReason) {
        if (this.degradationChanged("day-aggregates", true)) {
          console.warn(
            carried
              ? `[sensource] day aggregates unavailable (${dayReason}); carrying the last good values from ${clockOf(carried.at)}`
              : `[sensource] day aggregates unavailable (${dayReason}); nothing recent enough to carry, so peak, min, avg and capacity are unavailable`,
          );
        }
      } else if (this.degradationChanged("day-aggregates", false)) {
        console.log("[sensource] day aggregates are available again");
      }

      // Override the building total with the authoritative space-occupancy endpoint
      // (matches the Vea dashboard's live "Most Recent Occupancy"). Falls back to the
      // zone-derived net already in `dto.total` if a site has no spaces at all.
      let occSource = "zone-net";
      if (hasSpaces) {
        // CURRENT "in the room now" = Vea's live tracked occupancy from the most
        // recent per-minute bucket (matches the dashboard's "Most Recent Occupancy",
        // which clamps each sensor ≥0). The day-net Σins−Σouts under-counts a
        // multi-door room when a door logs more exits than entries. Vea has no
        // server-side time window (startDate/endDate 500), so we fetch the day's
        // minute series (occupancy max only) and take the newest bucket per space.
        // Falls back to the day-net if the minute series is unavailable.
        // Together, not in a chain — the same reason the requests above are.
        const [live, capacity] = await Promise.all([
          this.liveOccupancy(allowSpaces),
          this.spaceCapacity(allowSpaces),
        ]);
        if (spaces > 0 && day) {
          // A failed space listing must not blank a capacity read a minute ago:
          // null here means unknown, not zero.
          const heldCapacity = capacity ?? carried?.capacity ?? null;
          dto.total = {
            attendance: day.attendance,
            occupancy: live ?? day.occupancy,
            peak: day.peak,
            min: day.min,
            avg: day.avg,
            capacity: heldCapacity,
          };
          // Guarded here as well as before the emit: a configure() landing in
          // between would otherwise keep the old scope's aggregates alive for
          // another ten minutes.
          if (epoch === this.pollEpoch) {
            this.carriedDay = {
              peak: day.peak,
              min: day.min,
              avg: day.avg,
              capacity: heldCapacity,
              attendance: day.attendance,
              zoneAttendance,
              at: now,
              dateKey: zonedDateKey(now),
            };
          }
          occSource = `space×${spaces}/${live != null ? "minute" : "day-net"}`;
        } else {
          // No aggregates this poll. The live occupancy and today's attendance
          // are still this poll's; peak/min/avg/capacity are the last good set,
          // until it ages past DAY_AGGREGATE_STALE_MS and goes back to null.
          //
          // Before this, one rejected request took the whole space total with it
          // and the tiles for peak, avg and capacity flashed a dash on every
          // other poll. The reason was logged above, for both branches.
          if (live != null) dto.total.occupancy = live;
          // ATTENDANCE STAYS CONTINUOUS. buildDto has put the zone-derived total
          // in dto.total, and publishing that raw is a step change on every
          // degraded poll — 1600 to 2020 and back, with a second zone in scope —
          // in the very field the attendance recorder writes into service
          // history. So: the last space-derived count, advanced by what the
          // doors have counted since it was taken. Only with nothing to carry
          // does the zone total stand alone, which is then the best available
          // and is marked stale.
          if (carried) {
            dto.total.attendance = Math.max(
              0,
              carried.attendance + (zoneAttendance - carried.zoneAttendance),
            );
          }
          dto.total.peak = carried?.peak ?? null;
          dto.total.min = carried?.min ?? null;
          dto.total.avg = carried?.avg ?? null;
          dto.total.capacity = capacity ?? carried?.capacity ?? null;
          dto.total.dayAggregatesStale = true;
          occSource = `${live != null ? "minute" : "zone-net"}/day-${carried ? "carried" : "missing"}`;
        }
      }

      // Reconfigured while this poll was in flight: its answers describe a scope
      // the operator has replaced. Nothing is published and nothing is carried —
      // the poll the new configuration started is the one that speaks.
      if (epoch !== this.pollEpoch) {
        console.log("[sensource] the integration was reconfigured mid-poll; dropping this poll's answer");
        return;
      }

      const scope = allow ? `${reduced.zones.length} of selected zone(s)` : `${reduced.zones.length} zone(s)`;
      this.report("connected", `${scope}, occ via ${occSource}`);
      // Append a building-total sample to the rolling trend buffer, at the
      // buffer's own resolution rather than the poll's — see HISTORY_MIN_GAP_MS.
      this.appendHistory(dto);
      this.emit(dto);
      this.resetBackoff();
      ok = true;
    } catch (err) {
      const msg = errorMessage(err);
      // First failure only: an outage used to write one line per poll, forever.
      if (this.attempt === 0) console.error("[sensource] poll error:", msg);
      this.report("error", msg);
      this.goOffline();
    } finally {
      // In a finally, not at the end of each branch. connect() now IS the poller,
      // so a throw inside the catch — report(), or goOffline() reaching the
      // overridden emit() and a broadcast — would strand the integration with no
      // timer pending, no log, and no way back short of a restart. The old
      // setInterval was immune to that by construction; this restores it.
      // A poll from a replaced configuration must not re-arm the timer: the new
      // configuration's start() has already scheduled one, and two timers is the
      // doubled poll rate integration-base exists to prevent.
      if (this.running && epoch === this.pollEpoch) {
        if (ok) {
          // Poll at the configured rate while something is watching, and slowly
          // otherwise — the same shape REAPER and ProPresenter use. Never FASTER
          // than configured: pollSeconds has no upper bound, so an operator who
          // set 300s to stay inside Vea's quota would have been polled every 60s
          // all week by the idle path.
          const sec = Math.max(MIN_POLL_SECONDS, this.cfg?.pollSeconds || DEFAULT_POLL_SECONDS);
          const demand = this.inDemand;
          // Remembered, so a consumer arriving during the wait can pre-empt it
          // rather than sitting out the full idle interval. See pollNowIfIdle.
          this.polledIdle = !demand && IDLE_POLL_MS > sec * 1000;
          this.scheduleIn(demand ? sec * 1000 : Math.max(sec * 1000, IDLE_POLL_MS));
        } else {
          this.scheduleReconnect();
        }
      }
    }
  }

  protected override emit(snapshot: PeopleCountDTO): void {
    // Carry the rolling history on every snapshot (incl. OFFLINE) so the trend
    // graph holds its shape through a transient disconnect.
    this.last = { ...snapshot, history: this.history.slice() };
    // Skip re-broadcasting when the substantive counts are unchanged (updatedAt
    // ticks every poll but the count often doesn't, especially when idle). The next
    // real change carries the full history, so the trend graph still catches up.
    const sig = JSON.stringify([snapshot.connected, snapshot.total, snapshot.zones]);
    if (sig === this.lastCountSig) return;
    this.lastCountSig = sig;
    // Stamped, and bumped only here — past the unchanged-count return above, so
    // the version advances exactly when a real change is published. The hydrate
    // read answers from getLatest(), which carries the same counter, letting a
    // display drop a read that is older than a push it already applied. `sig` is
    // taken from the UNSTAMPED snapshot so the change test is unaffected.
    this.bumpRev();
    broadcast(this.channel, this.stamped(this.last));
  }
}

export const sensourceService = new SenSourceService();
