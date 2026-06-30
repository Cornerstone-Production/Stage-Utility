// sensource-service.ts — Polls the SenSource Vea people-counter API and
// broadcasts live counts on "people:count" for the dashboards + custom layouts.
//
// SenSource has no real-time endpoint, so we poll today's traffic on an interval
// (their data also lags a few minutes server-side, so ~30–60s is plenty). For
// each zone we compute:
//   attendance = Σ ins today      (how many entered)
//   occupancy  = Σ ins − Σ outs   (in the room now, clamped ≥0)
// and a building total across the selected zones.
//
// Auth is transparent to the operator: they enter an API client id + secret
// (created in the Vea app). We exchange those for a short-lived Bearer token via
// the documented client-credentials call and refresh it before expiry. A
// directly-pasted long-lived token is also accepted (skips the exchange).

import type { PeopleCountDTO, PeopleHistoryPoint, PeopleZoneCount } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";

type ConnState = "connected" | "error" | "disconnected";

const AUTH_URL = "https://auth.sensourceinc.com/oauth/token";
const API_BASE = "https://vea.sensourceinc.com/api";
const REQUEST_TIMEOUT_MS = 15000;
/** Refresh the token this far before it actually expires. */
const TOKEN_SKEW_MS = 60_000;
const DEFAULT_POLL_SECONDS = 45;
const MIN_POLL_SECONDS = 10;
/** Rolling trend buffer size (e.g. ~3h at the 45s default cadence). */
const HISTORY_CAP = 240;

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
  /** Parent location, when the API exposes it (field name varies / may be absent). */
  locationId: string | null;
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
  return { connected: true, updatedAt, total: { attendance, occupancy }, zones: reduced.zones };
}

class SenSourceService {
  private cfg: SenSourceConfig | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  private last: PeopleCountDTO = OFFLINE;
  /** Rolling building-total samples for the people-graph trend object. */
  private history: PeopleHistoryPoint[] = [];
  /** Cached /zone listing for location→zone scoping (see cachedZones). */
  private zonesCache: { at: number; zones: VeaZone[] } | null = null;

  private onConn: ((state: ConnState, message: string | null) => void) | null = null;
  private reported: ConnState | null = null;

  setConnectionListener(cb: (state: ConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  /** Latest snapshot — lets a freshly-loaded display hydrate immediately. */
  getLatest(): PeopleCountDTO {
    return this.last;
  }

  private report(state: ConnState, message: string | null): void {
    if (this.reported === state) return;
    this.reported = state;
    this.onConn?.(state, message);
  }

  configure(cfg: SenSourceConfig): void {
    this.cfg = cfg;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.reported = null;
    this.zonesCache = null;
    this.restart();
  }

  private hasCreds(): boolean {
    return !!this.cfg && (!!this.cfg.apiToken || (!!this.cfg.clientId && !!this.cfg.clientSecret));
  }

  start(): void {
    if (this.running || !this.hasCreds()) return;
    this.running = true;
    const sec = Math.max(MIN_POLL_SECONDS, this.cfg?.pollSeconds || DEFAULT_POLL_SECONDS);
    console.log(`[sensource] polling every ${sec}s`);
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), sec * 1000);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.last.connected) this.emit(OFFLINE);
  }

  private restart(): void {
    this.stop();
    if (this.hasCreds()) this.start();
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
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
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

  /** List the zones the client can see (backs the zone multi-select + scoping). */
  async listZones(): Promise<VeaZone[]> {
    const data = await this.apiGet<unknown>("/zone");
    return asRows(data)
      .map((z) => ({
        zoneId: String(z.zoneId ?? z.entityId ?? z.id ?? ""),
        name: typeof z.name === "string" && z.name ? z.name : String(z.zoneId ?? ""),
        locationId: probeLocationId(z),
      }))
      .filter((z) => z.zoneId);
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

  private async poll(): Promise<void> {
    if (!this.running || !this.cfg) return;
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
      const scope = allow ? `${reduced.zones.length} of selected zone(s)` : `${reduced.zones.length} zone(s)`;
      this.report("connected", scope);
      const dto = buildDto(reduced, new Date().toISOString());
      // Append a building-total sample to the rolling trend buffer.
      this.history.push({
        t: dto.updatedAt!,
        attendance: dto.total.attendance ?? 0,
        occupancy: dto.total.occupancy ?? 0,
      });
      if (this.history.length > HISTORY_CAP) this.history.splice(0, this.history.length - HISTORY_CAP);
      this.emit(dto);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sensource] poll error:", msg);
      this.report("error", msg);
      if (this.last.connected) this.emit(OFFLINE);
    }
  }

  private emit(snapshot: PeopleCountDTO): void {
    // Carry the rolling history on every snapshot (incl. OFFLINE) so the trend
    // graph holds its shape through a transient disconnect.
    this.last = { ...snapshot, history: this.history.slice() };
    broadcast("people:count", this.last);
  }
}

export const sensourceService = new SenSourceService();
