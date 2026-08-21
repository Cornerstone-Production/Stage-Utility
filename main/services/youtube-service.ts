// youtube-service.ts — are we live on YouTube, and since when.
//
// The one streaming source that answers both halves properly:
// `status.lifeCycleStatus === "live"` says we are on air, and
// `snippet.actualStartTime` says since when, from YouTube rather than from our
// own observation. If Resi restreams here — a YOUTUBE destination is in Resi's
// own enum — this reports the same broadcast Resi is pushing, which is why it
// is worth having even for a Resi-first church.
//
// OAUTH, NOT AN API KEY. `mine=true` is a question about the authenticated
// channel, so an API key cannot answer it; only an OAuth token can. The
// operator does the Google Cloud half once (project, consent screen, redirect)
// and this stores the refresh token as a secret, exchanging it for short-lived
// access tokens as needed.
//
// QUOTA IS A REAL CONSTRAINT. A project gets 10,000 units a day. Polling every
// 15s costs 5,760 — over half the budget on one question, before anything else
// this app might ever ask YouTube. So the cadence rides the same service-window
// clamp every other integration uses: quick while it matters, slow the rest of
// the week. A 403 that mentions quota backs off to the idle cadence rather than
// hammering a door that will not open again until midnight Pacific.

import { errorMessage } from "./errors.js";
import type { StreamStatusDTO } from "../types/stage.js";
import { StatusIntegration } from "./integration-base.js";

const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const BROADCASTS = "https://www.googleapis.com/youtube/v3/liveBroadcasts";

const REQUEST_TIMEOUT_MS = 10_000;
/** While something is watching. */
const POLL_MS = 20_000;
/** Nobody watching. Keeps a week of idling near 700 units rather than 5,760. */
const IDLE_POLL_MS = 300_000;
/** After YouTube says the quota is gone. It resets at midnight Pacific; there is
 *  nothing to be gained by asking sooner than this. */
const QUOTA_BACKOFF_MS = 1_800_000;

const OFFLINE: StreamStatusDTO = {
  connected: false,
  live: false,
  startedAt: null,
  detail: null,
};

/** As much of a liveBroadcast as this reads. */
export interface YouTubeBroadcast {
  id?: string;
  snippet?: { title?: string | null; actualStartTime?: string | null } | null;
  status?: { lifeCycleStatus?: string | null } | null;
}

/**
 * Is this broadcast on air?
 *
 * `live` only. The lifecycle also has `testing` and `liveStarting`, and neither
 * is streaming to an audience — a "we are live" indicator that lights during a
 * test broadcast would be lying at exactly the moment somebody trusts it.
 */
export function broadcastIsLive(b: YouTubeBroadcast): boolean {
  return (b.status?.lifeCycleStatus ?? "").trim().toLowerCase() === "live";
}

/** The earliest actual start among the live broadcasts, or null. */
export function earliestStart(list: readonly YouTubeBroadcast[]): string | null {
  const times = list
    .map((b) => b.snippet?.actualStartTime)
    .filter((x): x is string => typeof x === "string" && !!x)
    .map((x) => Date.parse(x))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/** Does this error mean the daily quota is spent? */
export function isQuotaError(status: number, body: string): boolean {
  return status === 403 && /quota/i.test(body);
}

class YouTubeService extends StatusIntegration<StreamStatusDTO> {
  private clientId: string | null = null;
  private clientSecret: string | null = null;
  private refreshToken: string | null = null;

  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  private quotaSpent = false;

  constructor() {
    super("youtube", "youtube:status", OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.clientId && !!this.clientSecret && !!this.refreshToken;
  }

  configure(clientId: string, clientSecret: string, refreshToken: string): void {
    const next = [clientId?.trim() || null, clientSecret || null, refreshToken?.trim() || null] as const;
    if (next[0] !== this.clientId || next[1] !== this.clientSecret || next[2] !== this.refreshToken) {
      this.accessToken = null;
      this.accessExpiresAt = 0;
      this.quotaSpent = false;
    }
    [this.clientId, this.clientSecret, this.refreshToken] = next;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log("[youtube] polling live broadcasts");
    super.start();
  }

  async test(clientId: string, clientSecret: string, refreshToken: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const token = await this.exchangeRefresh(clientId, clientSecret, refreshToken);
      const list = await this.fetchActive(token);
      const live = list.filter(broadcastIsLive);
      return {
        ok: true,
        message: live.length
          ? `Connected — live now: ${live.map((b) => b.snippet?.title ?? b.id).join(", ")}`
          : "Connected to YouTube — nothing live right now",
      };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  private async exchangeRefresh(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(OAUTH_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        signal: ctrl.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
      if (!res.ok || !body.access_token) {
        // Google's error_description is genuinely useful here — "Token has been
        // expired or revoked" tells the operator exactly what to redo.
        throw new Error(body.error_description || body.error || `Google returned HTTP ${res.status}`);
      }
      return body.access_token;
    } finally {
      clearTimeout(t);
    }
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessExpiresAt - 60_000) return this.accessToken;
    if (!this.clientId || !this.clientSecret || !this.refreshToken) throw new Error("YouTube is not configured");
    const token = await this.exchangeRefresh(this.clientId, this.clientSecret, this.refreshToken);
    this.accessToken = token;
    // Google's access tokens are an hour; assume the short end rather than
    // parsing a field we would then have to trust.
    this.accessExpiresAt = Date.now() + 55 * 60_000;
    return token;
  }

  private async fetchActive(token: string): Promise<YouTubeBroadcast[]> {
    const url = `${BROADCASTS}?part=snippet%2Cstatus&broadcastStatus=active&mine=true&maxResults=5`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (isQuotaError(res.status, text)) {
          this.quotaSpent = true;
          throw new Error("YouTube's daily API quota is spent — it resets at midnight Pacific");
        }
        throw new Error(`YouTube returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as { items?: YouTubeBroadcast[] };
      this.quotaSpent = false;
      return Array.isArray(body.items) ? body.items : [];
    } finally {
      clearTimeout(t);
    }
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.configured) return;
    try {
      const token = await this.ensureAccessToken();
      const items = await this.fetchActive(token);
      if (!this.running) return;

      const live = items.filter(broadcastIsLive);
      if (!this.last.connected) {
        this.resetBackoff();
        this.report("connected", "Connected to YouTube");
      }

      this.emitIfChanged({
        connected: true,
        live: live.length > 0,
        startedAt: earliestStart(live),
        detail: live.map((b) => b.snippet?.title ?? b.id ?? "").filter(Boolean).join(" + ") || null,
      });

      this.scheduleIn(this.inDemand ? POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      const msg = errorMessage(err);
      if (this.attempt === 0) console.warn(`[youtube] ${msg} — backing off quietly`);
      // A refused token is worth dropping so the next attempt re-exchanges.
      this.accessToken = null;
      this.report("error", msg);
      this.goOffline();
      // Quota is not a connection problem and retrying does not fix it. Wait it
      // out rather than spending the next day's units re-asking every 3 seconds.
      if (this.quotaSpent) this.scheduleIn(QUOTA_BACKOFF_MS);
      else this.scheduleReconnect();
    }
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
    this.accessToken = null;
    this.accessExpiresAt = 0;
  }
}

export const youtubeService = new YouTubeService();
