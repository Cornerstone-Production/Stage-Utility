// resi-service.ts — is the Resi encoder streaming, and since when.
//
// THIS RIDES AN UNDOCUMENTED API, DELIBERATELY.
//
// Resi's published "Go Live API" (api.resi.io) cannot answer the question this
// integration exists for. It has no way to list active schedules — the only
// source of a scheduleId is the POST that starts a stream — so it can report
// only on streams this app itself started. Cornerstone's Resi goes live on
// Resi's own schedule, which that API cannot see at all. There are no webhooks:
// the words do not appear in its OpenAPI spec, and /v1/schedules and /v1/events
// both 404. Bitfocus's own resi-studio module confirms the shape by persisting
// the schedule ids it created, because it cannot discover them either.
//
// The internal Web API behind central.resi.io reports ENCODER state, which is
// true whoever started the stream. That is the whole reason this file talks to
// an endpoint Resi does not document, and the risk is real: it may change
// without notice. When it does, this integration reports a clear error and
// everything else keeps working — which is why the failure path below never
// throws past its caller.
//
// Two quirks worth knowing before editing:
//   - The auth header is `X-Bearer`, not `Bearer`.
//   - The token endpoint wants grant_type "password_cookie" with the account
//     username and password. There is no scoped credential for this API.

import { errorMessage } from "./errors.js";
import type { StreamStatusDTO } from "../types/stage.js";
import { StatusIntegration } from "./integration-base.js";
import { streamStartStore } from "./stream-start-store.js";

const API = "https://central.resi.io/api/v3";
const API_V2 = "https://central.resi.io/api_v2.svc";

const REQUEST_TIMEOUT_MS = 10_000;
/** While something is watching. Resi's own status is ~20s fresh, so faster than
 *  this buys nothing but requests. */
const POLL_MS = 15_000;
/** Nobody watching: the automation engine still wants to know we went live. */
const IDLE_POLL_MS = 120_000;

const OFFLINE: StreamStatusDTO = {
  connected: false,
  live: false,
  startedAt: null,
  detail: null,
};

/** One encoder, as much of it as we rely on. The payload carries far more;
 *  naming only what is read keeps a field rename from looking like a rewrite. */
export interface ResiEncoder {
  uuid: string;
  name?: string | null;
  status?: string | null;
  videoInputSource?: unknown;
  lastUpdate?: string | null;
  /** Resi has not been observed to send a start time. If a payload turns out to
   *  carry one, prefer it over our own first-observed moment — see
   *  `startedAtFrom`. */
  startedAt?: string | null;
  startTime?: string | null;
}

/**
 * Is this encoder streaming?
 *
 * `started` is the value Resi uses and the one Bitfocus's module keys its live
 * feedback on. Compared case-insensitively because an undocumented API is free
 * to change the casing without telling anybody, and a live indicator that goes
 * dark over a capital letter is the worst possible failure here.
 */
export function encoderIsLive(e: ResiEncoder): boolean {
  return (e.status ?? "").trim().toLowerCase() === "started";
}

/**
 * A start time from the payload, if it has one.
 *
 * Kept as its own function because it is the open question in this integration:
 * the fields are guesses at names Resi may or may not send, and the caller falls
 * back to the first moment WE saw the stream. Anything unparseable is treated as
 * absent rather than passed on, so a garbage stamp cannot become a wrong clock.
 */
export function startedAtFrom(e: ResiEncoder): string | null {
  for (const v of [e.startedAt, e.startTime]) {
    if (typeof v !== "string" || !v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** Pick the encoders this integration reports on. Empty selection means "all of
 *  them", so an operator who has not chosen yet still sees the truth. */
export function selectedEncoders(all: ResiEncoder[], wanted: readonly string[]): ResiEncoder[] {
  if (!wanted.length) return all;
  const want = new Set(wanted);
  return all.filter((e) => want.has(e.uuid));
}

class ResiService extends StatusIntegration<StreamStatusDTO> {
  private username: string | null = null;
  private password: string | null = null;
  private encoderIds: string[] = [];

  private token: string | null = null;
  private tokenExpiresAt = 0;
  private customerId: string | null = null;

  /** Encoder id -> name, for the sub-line. Refreshed with the status poll. */
  private names = new Map<string, string>();

  constructor() {
    super("resi", "resi:status", OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.username && !!this.password;
  }

  configure(username: string, password: string, encoderIds: string[] = []): void {
    const nextUser = username?.trim() || null;
    const nextPass = password || null;
    // Credentials changed: the cached token belongs to the old account.
    if (nextUser !== this.username || nextPass !== this.password) {
      this.token = null;
      this.tokenExpiresAt = 0;
      this.customerId = null;
    }
    this.username = nextUser;
    this.password = nextPass;
    this.encoderIds = encoderIds.filter(Boolean);
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log("[resi] polling encoder status");
    super.start();
  }

  /** One-shot check for the Integrations "Test connection" button. */
  async test(username: string, password: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const token = await this.fetchToken(username, password);
      const customerId = await this.fetchCustomerId(token);
      const encoders = await this.fetchEncoderStatus(token, customerId);
      const live = encoders.filter(encoderIsLive).length;
      return {
        ok: true,
        message: `Connected to Resi — ${encoders.length} encoder${encoders.length === 1 ? "" : "s"}, ${live} streaming`,
      };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /** Encoders to choose from, for the picker. Throws so the caller can report. */
  async listEncoders(): Promise<{ id: string; name: string }[]> {
    const token = await this.ensureToken();
    const customerId = await this.ensureCustomerId(token);
    const list = await this.fetchEncoderStatus(token, customerId);
    return list.map((e) => ({ id: e.uuid, name: e.name || e.uuid }));
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) {
        // 401 is the one worth naming: on an undocumented API it usually means
        // the credentials are wrong, not that the shape changed.
        if (res.status === 401) throw new Error("Resi rejected the username or password");
        throw new Error(`Resi returned HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  private async fetchToken(username: string, password: string): Promise<string> {
    const body = await this.json<{ access_token?: string; expires_in?: number }>(`${API}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, grant_type: "password_cookie" }),
    });
    if (!body.access_token) throw new Error("Resi returned no access token");
    return body.access_token;
  }

  private async ensureToken(): Promise<string> {
    // 60s of headroom: a token that expires mid-request would surface as a
    // spurious auth error and a needless reconnect.
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.username || !this.password) throw new Error("Resi is not configured");
    const body = await this.json<{ access_token?: string; expires_in?: number }>(`${API}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
        grant_type: "password_cookie",
      }),
    });
    if (!body.access_token) throw new Error("Resi returned no access token");
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  private async fetchCustomerId(token: string): Promise<string> {
    const me = await this.json<{ customerId?: string }>(`${API_V2}/users/me`, {
      headers: { Authorization: `X-Bearer ${token}` },
    });
    if (!me.customerId) throw new Error("Resi did not return a customer id");
    return me.customerId;
  }

  private async ensureCustomerId(token: string): Promise<string> {
    if (this.customerId) return this.customerId;
    this.customerId = await this.fetchCustomerId(token);
    return this.customerId;
  }

  private async fetchEncoderStatus(token: string, customerId: string): Promise<ResiEncoder[]> {
    const list = await this.json<ResiEncoder[]>(
      `${API}/customers/${encodeURIComponent(customerId)}/encoders/status?wide=true`,
      { headers: { Authorization: `X-Bearer ${token}` } },
    );
    return Array.isArray(list) ? list : [];
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.configured) return;
    try {
      const token = await this.ensureToken();
      const customerId = await this.ensureCustomerId(token);
      const all = await this.fetchEncoderStatus(token, customerId);
      if (!this.running) return;

      for (const e of all) if (e.name) this.names.set(e.uuid, e.name);
      const watched = selectedEncoders(all, this.encoderIds);
      const live = watched.filter(encoderIsLive);

      if (!this.last.connected) {
        this.resetBackoff();
        this.report("connected", `Connected to Resi — watching ${watched.length || "all"} encoder(s)`);
      }

      this.emitIfChanged({
        connected: true,
        live: live.length > 0,
        startedAt: this.startedFor(live),
        detail: live.length
          ? live.map((e) => this.names.get(e.uuid) ?? e.uuid).join(" + ")
          : watched.map((e) => this.names.get(e.uuid) ?? e.uuid).join(" + ") || null,
      });

      this.scheduleIn(this.inDemand ? POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      const msg = errorMessage(err);
      if (this.attempt === 0) console.warn(`[resi] status unavailable (${msg}) — backing off quietly`);
      // A rejected token is worth dropping so the next attempt re-authenticates
      // rather than replaying a credential Resi has already refused.
      this.token = null;
      this.report("error", `Can't reach Resi — ${msg}`);
      this.goOffline();
      this.scheduleReconnect();
    }
  }

  /**
   * When the stream started.
   *
   * Resi's payload has not been observed to carry a start time, so this prefers
   * one if it appears and otherwise remembers the first moment WE saw the
   * encoder streaming. That memory is persisted, because the alternative is a
   * clock that resets to zero when the server restarts mid-service — which is
   * exactly when somebody is looking at it.
   */
  private startedFor(live: ResiEncoder[]): string | null {
    if (!live.length) {
      streamStartStore.clear("resi");
      return null;
    }
    const reported = live.map(startedAtFrom).filter((x): x is string => !!x);
    if (reported.length) {
      const earliest = new Date(Math.min(...reported.map((x) => Date.parse(x)))).toISOString();
      streamStartStore.remember("resi", earliest);
      return earliest;
    }
    return streamStartStore.observe("resi");
  }

  private emitIfChanged(next: StreamStatusDTO): void {
    const p = this.last;
    const changed =
      p.connected !== next.connected ||
      p.live !== next.live ||
      p.startedAt !== next.startedAt ||
      p.detail !== next.detail;
    if (changed) this.emit(next);
    else this.last = next;
  }

  override stop(): void {
    super.stop();
    this.token = null;
    this.tokenExpiresAt = 0;
  }
}

export const resiService = new ResiService();
