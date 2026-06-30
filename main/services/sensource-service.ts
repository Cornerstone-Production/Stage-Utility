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

/** Sum a day's traffic rows into per-zone attendance/occupancy. Tolerant of both
 *  the detailed (`ins`/`outs`) and grouped (`sumins`/`sumouts`) response shapes,
 *  and of rows that omit the zone name. Exported for unit tests. */
export function reduceTraffic(rows: unknown[]): PeopleZoneCount[] {
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
    const ins = num(row.sumins) ?? num(row.ins) ?? 0;
    const outs = num(row.sumouts) ?? num(row.outs) ?? 0;
    const name = typeof row.name === "string" && row.name ? row.name : null;
    const cur = byZone.get(id) ?? { name: id, ins: 0, outs: 0 };
    cur.ins += ins;
    cur.outs += outs;
    if (name) cur.name = name;
    byZone.set(id, cur);
  }
  return [...byZone.entries()].map(([id, z]) => ({
    id,
    name: z.name,
    attendance: Math.max(0, Math.round(z.ins)),
    occupancy: Math.max(0, Math.round(z.ins - z.outs)),
  }));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function buildDto(zones: PeopleZoneCount[], updatedAt: string): PeopleCountDTO {
  const attendance = zones.reduce((s, z) => s + z.attendance, 0);
  const occupancy = zones.reduce((s, z) => s + z.occupancy, 0);
  return { connected: true, updatedAt, total: { attendance, occupancy }, zones };
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
    if (!Array.isArray(data)) return [];
    return data
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
      .map((l) => ({
        locationId: String(l.locationId ?? ""),
        name: typeof l.name === "string" ? l.name : String(l.locationId ?? ""),
      }))
      .filter((l) => l.locationId);
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
      const params = new URLSearchParams({
        relativeDate: "today",
        dateGroupings: "day",
        entityType: "zone",
        metrics: "ins,outs",
      });
      // entityIds restricts to chosen zones; otherwise a locationId narrows to
      // one location so the org-wide default isn't pulled when nothing is set.
      if (this.cfg.zoneIds.length) params.set("entityIds", this.cfg.zoneIds.join(","));
      else if (this.cfg.locationId) params.set("locationIds", this.cfg.locationId);

      const body = await this.apiGet<{ results?: unknown[] }>(`/data/traffic?${params.toString()}`);
      const zones = reduceTraffic(body.results ?? []);
      this.report("connected", `${zones.length} zone(s)`);
      const dto = buildDto(zones, new Date().toISOString());
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
