// sensource-service.ts — Polls the SenSource Vea people-counter API and
// broadcasts live counts on "people:count" for the dashboards + custom layouts.
//
// SenSource has no real-time endpoint, so we poll on an interval (their data
// lags a few minutes server-side, so ~30–60s is plenty).
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
// Auth is transparent to the operator: they enter an API client id + secret
// (created in the Vea app). We exchange those for a short-lived Bearer token via
// the documented client-credentials call and refresh it before expiry. A
// directly-pasted long-lived token is also accepted (skips the exchange).

import { errorMessage } from "./errors.js";
import type { PeopleCountDTO, PeopleHistoryPoint, PeopleZoneCount } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { StatusIntegration } from "./integration-base.js";


const AUTH_URL = "https://auth.sensourceinc.com/oauth/token";
const API_BASE = "https://vea.sensourceinc.com/api";
const REQUEST_TIMEOUT_MS = 15000;
/** Refresh the token this far before it actually expires. */
const TOKEN_SKEW_MS = 60_000;
const DEFAULT_POLL_SECONDS = 45;
const MIN_POLL_SECONDS = 10;
/** Rolling trend buffer size (e.g. ~3h at the 45s default cadence). */
const HISTORY_CAP = 240;
/** Poll rate when no display is watching the people count. The configured rate
 *  is for a live service; between them nobody is reading it. */
const IDLE_POLL_MS = 60_000;

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

  private lastCountSig: string | null = null;
  /** Rolling building-total samples for the people-graph trend object. */
  private history: PeopleHistoryPoint[] = [];
  /** Cached /zone listing for location→zone scoping (see cachedZones). */
  private zonesCache: { at: number; zones: VeaZone[] } | null = null;
  /** Cached /space listing for the authoritative building occupancy. */
  private spacesCache: { at: number; spaces: VeaSpace[] } | null = null;
  /** Consumers that read getLatest() in-process. See addDemandSource. */
  private demandSources: (() => boolean)[] = [];

  /**
   * Register something that consumes people counts without an SSE subscription.
   *
   * The idle gate below slows polling to once a minute when nobody is watching,
   * and asked only `channelHasSubscribers` — a browser question. Two consumers
   * live inside this process and are invisible to it: the attendance recorder
   * pulls getLatest() on every live tick, and tslService pushes it to the
   * scoreboard. On a Sunday with no people-count display open, the recorder was
   * therefore sampling counts up to a minute stale for the whole service, and
   * the graph it drew was the shape of the poll gate rather than of the room.
   *
   * A callback rather than an import: this service knowing about its consumers
   * directly would be a cycle, since both of them import it.
   */
  addDemandSource(wantsFreshCounts: () => boolean): void {
    this.demandSources.push(wantsFreshCounts);
  }

  /** Is anything — a browser or an in-process consumer — actually using this? */
  private get inDemand(): boolean {
    return this.hasSubscribers || this.demandSources.some((wants) => wants());
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
    this.token = null;
    this.tokenExpiresAt = 0;
    this.resetReport();
    this.zonesCache = null;
    this.spacesCache = null;
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
      this.token = null;
      this.tokenExpiresAt = 0;
      try {
        const locations = await this.listLocations();
        return { ok: true, message: `Authenticated — ${locations.length} location(s) visible` };
      } finally {
        this.cfg = prev;
        this.token = null;
        this.tokenExpiresAt = 0;
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
      this.token = null;
      this.tokenExpiresAt = 0;
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
    } catch (err) {
      console.warn("[sensource] /sensor join failed (zones won't map to locations):", err);
    }
    return m;
  }

  private async siteToLocation(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try {
      for (const s of asRows(await this.apiGet<unknown>("/site"))) {
        if (typeof s.siteId === "string" && typeof s.locationId === "string") m.set(s.siteId, s.locationId);
      }
    } catch (err) {
      console.warn("[sensource] /site join failed (zones won't map to locations):", err);
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
      this.token = null;
      this.tokenExpiresAt = 0;
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
        if (ids.length) return new Set(ids);
        console.warn(
          "[sensource] a location is selected but no zones map to it (the API may not expose zone→location); counting all visible zones. Pick specific zones to scope reliably.",
        );
      } catch (err) {
        console.warn("[sensource] zone resolution failed; counting all zones:", err);
      }
    }
    return null;
  }

  private async cachedSpaces(): Promise<VeaSpace[]> {
    const now = Date.now();
    if (this.spacesCache && now - this.spacesCache.at < ZONES_TTL_MS) return this.spacesCache.spaces;
    const spaces = await this.listSpaces();
    this.spacesCache = { at: now, spaces };
    return spaces;
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

    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Auth failed (HTTP ${res.status}) — check client id/secret`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Auth response had no access_token");
    this.token = json.access_token;
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    this.tokenExpiresAt = Date.now() + Math.max(0, ttlMs - TOKEN_SKEW_MS);
    return `Bearer ${this.token}`;
  }

  private async apiGet<T>(path: string, retryOn401 = true): Promise<T> {
    const auth = await this.authHeader();
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", Authorization: auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 && retryOn401 && !this.cfg?.apiToken) {
      // Token may have been revoked early — drop it and try once more.
      this.token = null;
      this.tokenExpiresAt = 0;
      return this.apiGet<T>(path, false);
    }
    if (!res.ok) throw new Error(`SenSource ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  // ── Poll ──────────────────────────────────────────────────────────────────

  protected async connect(): Promise<void> {
    if (!this.running || !this.cfg) return;
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

      const allow = await this.resolveAllowedZones();
      const body = await this.apiGet<{ results?: unknown[] }>(`/data/traffic?${params.toString()}`);
      const reduced = reduceTraffic(body.results ?? [], allow);
      const dto = buildDto(reduced, new Date().toISOString());

      // Override the building total with the authoritative space-occupancy endpoint
      // (matches the Vea dashboard's live "Most Recent Occupancy"). Falls back to the
      // zone-derived net already in `dto.total` if a site has no spaces or it fails.
      let occSource = "zone-net";
      try {
        const allowSpaces = await this.resolveAllowedSpaces();
        // Day stats: attendance (Σ entries), peak/min/avg occupancy for the day.
        const oParams = new URLSearchParams({
          relativeDate: "today",
          dateGroupings: "day",
          entityType: "space",
          metrics: "occupancy(max),occupancy(min),occupancy(avg)",
        });
        const oBody = await this.apiGet<{ results?: unknown[] }>(`/data/occupancy?${oParams.toString()}`);
        const occ = reduceSpaceOccupancy(oBody.results ?? [], allowSpaces);
        if (occ.spaces > 0) {
          // CURRENT "in the room now" = Vea's live tracked occupancy from the most
          // recent per-minute bucket (matches the dashboard's "Most Recent Occupancy",
          // which clamps each sensor ≥0). The day-net Σins−Σouts under-counts a
          // multi-door room when a door logs more exits than entries. Vea has no
          // server-side time window (startDate/endDate 500), so we fetch the day's
          // minute series (occupancy max only) and take the newest bucket per space.
          // Falls back to the day-net if the minute series is unavailable.
          let current = occ.occupancy;
          let curSource = "day-net";
          try {
            const mParams = new URLSearchParams({
              relativeDate: "today",
              dateGroupings: "minute",
              entityType: "space",
              metrics: "occupancy(max)",
            });
            const mBody = await this.apiGet<{ results?: unknown[] }>(`/data/occupancy?${mParams.toString()}`);
            const live = latestSpaceOccupancy(mBody.results ?? [], allowSpaces);
            if (live != null) {
              current = live;
              curSource = "minute";
            }
          } catch (err) {
            console.warn("[sensource] live minute occupancy unavailable; using day-net:", err);
          }
          // Building capacity = Σ maxCapacity over the same (allowed) spaces.
          const cap = (await this.cachedSpaces())
            .filter((s) => !allowSpaces || allowSpaces.size === 0 || allowSpaces.has(s.spaceId))
            .reduce((a, s) => a + (s.maxCapacity ?? 0), 0);
          dto.total = {
            attendance: occ.attendance,
            occupancy: current,
            peak: occ.peak,
            min: occ.min,
            avg: occ.avg,
            capacity: cap > 0 ? cap : null,
          };
          occSource = `space×${occ.spaces}/${curSource}`;
        }
      } catch (err) {
        console.warn("[sensource] space occupancy unavailable; using zone-derived total:", err);
      }

      const scope = allow ? `${reduced.zones.length} of selected zone(s)` : `${reduced.zones.length} zone(s)`;
      this.report("connected", `${scope}, occ via ${occSource}`);
      // Append a building-total sample to the rolling trend buffer.
      this.history.push({
        t: dto.updatedAt!,
        attendance: dto.total.attendance ?? 0,
        occupancy: dto.total.occupancy ?? 0,
      });
      if (this.history.length > HISTORY_CAP) this.history.splice(0, this.history.length - HISTORY_CAP);
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
      if (this.running) {
        if (ok) {
          // Poll at the configured rate while something is watching, and slowly
          // otherwise — the same shape REAPER and ProPresenter use. Never FASTER
          // than configured: pollSeconds has no upper bound, so an operator who
          // set 300s to stay inside Vea's quota would have been polled every 60s
          // all week by the idle path.
          const sec = Math.max(MIN_POLL_SECONDS, this.cfg?.pollSeconds || DEFAULT_POLL_SECONDS);
          this.scheduleIn(this.inDemand ? sec * 1000 : Math.max(sec * 1000, IDLE_POLL_MS));
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
    broadcast(this.channel, this.last);
  }
}

export const sensourceService = new SenSourceService();
