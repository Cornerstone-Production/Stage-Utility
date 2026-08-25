// youtube-service.ts — are we live on YouTube, and since when.
//
// TWO WAYS TO ASK, because the honest answer to "how do I set this up" depends
// on whether the stream is public.
//
//   API KEY (the default). Reads the channel's uploads playlist and then the
//   videos on it, the way any viewer's client could. Setup is a key and a
//   channel. It sees PUBLIC broadcasts only, which for a church streaming a
//   service to the world is every broadcast that matters — and it answers the
//   question that actually matters when Resi is restreaming here: is it
//   reaching viewers. It checks from outside rather than asking our own
//   account, which is the stronger signal.
//
//   OAUTH. `liveBroadcasts.list?mine=true` is authoritative and sees private
//   and unlisted broadcasts too. It costs a Google Cloud OAuth client, a
//   consent round-trip and a refresh token to look after. Worth it only if the
//   streams are not public.
//
// An API key cannot answer `mine=true` — that is a question about the
// authenticated channel — which is why the second mode exists at all rather
// than being a lighter spelling of the first.
//
// QUOTA IS A REAL CONSTRAINT either way. A project gets 10,000 units a day.
// OAuth costs 1 unit a poll; the key path costs 2 (playlist, then videos) after
// a one-off channel lookup that is cached for the life of the process. What is
// NOT affordable is the obvious-looking `search.list?eventType=live`: it costs
// 100 units a call, so polling it once a minute through a single service would
// spend nearly twice the day's budget. It is not used here for that reason.
//
// Cadence rides the same service-window clamp every other integration uses:
// quick while it matters, slow the rest of the week. A 403 that mentions quota
// backs off to half an hour rather than hammering a door that will not open
// again until midnight Pacific.

import { errorMessage } from "./errors.js";
import type { StreamStatusDTO } from "../types/stage.js";
import { StatusIntegration } from "./integration-base.js";

const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";

const REQUEST_TIMEOUT_MS = 10_000;
/** While something is watching. */
const POLL_MS = 20_000;
/** Nobody watching. Keeps a week of idling near 700 units rather than 5,760. */
const IDLE_POLL_MS = 300_000;
/** After YouTube says the quota is gone. It resets at midnight Pacific; there is
 *  nothing to be gained by asking sooner than this. */
const QUOTA_BACKOFF_MS = 1_800_000;

/** How many recent uploads to inspect. A live broadcast is by definition the
 *  newest thing on the channel, but a stream started right after an upload — or
 *  two streams in a morning — should not fall off the end. */
const RECENT_UPLOADS = 5;

const OFFLINE: StreamStatusDTO = {
  connected: false,
  live: false,
  startedAt: null,
  detail: null,
};

export type YouTubeMode = "key" | "oauth";

export interface YouTubeConfig {
  mode: YouTubeMode;
  apiKey: string;
  /** A channel id (UC…) or an @handle. Resolved to an uploads playlist once. */
  channel: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** As much of a liveBroadcast as the OAuth path reads. */
export interface YouTubeBroadcast {
  id?: string;
  snippet?: { title?: string | null; actualStartTime?: string | null } | null;
  status?: { lifeCycleStatus?: string | null } | null;
}

/** As much of a video as the API-key path reads. */
export interface YouTubeVideo {
  id?: string;
  snippet?: { title?: string | null; liveBroadcastContent?: string | null } | null;
  liveStreamingDetails?: {
    actualStartTime?: string | null;
    actualEndTime?: string | null;
  } | null;
}

/**
 * Is this broadcast on air? (OAuth path.)
 *
 * `live` only. The lifecycle also has `testing` and `liveStarting`, and neither
 * is streaming to an audience — a "we are live" indicator that lights during a
 * test broadcast would be lying at exactly the moment somebody trusts it.
 */
export function broadcastIsLive(b: YouTubeBroadcast): boolean {
  return (b.status?.lifeCycleStatus ?? "").trim().toLowerCase() === "live";
}

/**
 * Is this video on air right now? (API-key path.)
 *
 * Two signals, and either is enough:
 *
 *   - `snippet.liveBroadcastContent === "live"`, YouTube's own flag.
 *   - a real start time with NO end time. A finished stream keeps its
 *     actualStartTime and gains an actualEndTime, and an ordinary upload has
 *     neither, so the pair distinguishes all three without the flag.
 *
 * The flag has been observed to lag the stream by a poll or two, and the
 * timestamps have been observed to lag the flag. Requiring both would mean
 * missing the first minute of a service; accepting either costs nothing,
 * because an ended stream fails both.
 */
export function videoIsLive(v: YouTubeVideo): boolean {
  if ((v.snippet?.liveBroadcastContent ?? "").trim().toLowerCase() === "live") return true;
  const d = v.liveStreamingDetails;
  return !!d?.actualStartTime && !d?.actualEndTime;
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

/**
 * The uploads playlist for a channel id.
 *
 * YouTube's own convention: the uploads playlist of `UCxxxx` is `UUxxxx`. Only
 * used as a fallback — `channels.list` is asked first and its answer preferred,
 * because a documented field beats a string transform that happens to hold.
 */
export function uploadsPlaylistFrom(channelId: string): string | null {
  return /^UC[\w-]{20,}$/.test(channelId) ? `UU${channelId.slice(2)}` : null;
}

/** Does this error mean the daily quota is spent? */
export function isQuotaError(status: number, body: string): boolean {
  return status === 403 && /quota/i.test(body);
}

const EMPTY: YouTubeConfig = {
  mode: "key",
  apiKey: "",
  channel: "",
  clientId: "",
  clientSecret: "",
  refreshToken: "",
};

class YouTubeService extends StatusIntegration<StreamStatusDTO> {
  private cfg: YouTubeConfig = EMPTY;

  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  private quotaSpent = false;
  /** Resolved once per channel and kept: it does not change, and asking again
   *  every poll would double the quota cost of the cheap path. */
  private uploadsPlaylist: string | null = null;

  constructor() {
    super("youtube", "youtube:status", OFFLINE);
  }

  protected get configured(): boolean {
    return configComplete(this.cfg);
  }

  configure(next: YouTubeConfig): void {
    const changed = (Object.keys(EMPTY) as (keyof YouTubeConfig)[]).some((k) => next[k] !== this.cfg[k]);
    if (changed) {
      // Anything cached belongs to the old credentials or the old channel.
      this.accessToken = null;
      this.accessExpiresAt = 0;
      this.quotaSpent = false;
      this.uploadsPlaylist = null;
    }
    this.cfg = { ...next };
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[youtube] polling live status (${this.cfg.mode === "key" ? "public channel" : "OAuth"})`);
    super.start();
  }

  async test(cfg: YouTubeConfig): Promise<{ ok: boolean; message?: string }> {
    try {
      if (!configComplete(cfg)) return { ok: false, message: "Fill in the fields for the chosen mode first" };
      const { live, detail } = await this.look(cfg, { fresh: true });
      return {
        ok: true,
        message: live ? `Connected — live now: ${detail ?? "untitled"}` : "Connected to YouTube — nothing live right now",
      };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (isQuotaError(res.status, text)) {
        this.quotaSpent = true;
        throw new Error("YouTube's daily API quota is spent — it resets at midnight Pacific");
      }
      if (res.status === 400 || res.status === 403) {
        throw new Error(`YouTube rejected the request (HTTP ${res.status}) — check the API key and channel`);
      }
      throw new Error(`YouTube returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as T;
    this.quotaSpent = false;
    return body;
  }

  private async exchangeRefresh(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
    const res = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error_description?: string;
      error?: string;
    };
    if (!res.ok || !body.access_token) {
      // Google's error_description is genuinely useful here — "Token has been
      // expired or revoked" tells the operator exactly what to redo.
      throw new Error(body.error_description || body.error || `Google returned HTTP ${res.status}`);
    }
    return body.access_token;
  }

  private async ensureAccessToken(cfg: YouTubeConfig): Promise<string> {
    if (this.accessToken && Date.now() < this.accessExpiresAt - 60_000) return this.accessToken;
    const token = await this.exchangeRefresh(cfg.clientId, cfg.clientSecret, cfg.refreshToken);
    this.accessToken = token;
    // Google's access tokens are an hour; assume the short end rather than
    // parsing a field we would then have to trust.
    this.accessExpiresAt = Date.now() + 55 * 60_000;
    return token;
  }

  // ── The two ways to look ──────────────────────────────────────────────────

  /**
   * The channel's uploads playlist.
   *
   * `channels.list` accepts an id or an @handle, so the operator can paste
   * either. One unit, once — the answer is cached for the life of the process
   * because a channel's uploads playlist does not change.
   */
  private async resolveUploads(cfg: YouTubeConfig): Promise<string> {
    if (this.uploadsPlaylist) return this.uploadsPlaylist;
    const channel = cfg.channel.trim();
    const by = channel.startsWith("@")
      ? `forHandle=${encodeURIComponent(channel)}`
      : `id=${encodeURIComponent(channel)}`;
    const body = await this.json<{
      items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
    }>(`${API}/channels?part=contentDetails&${by}&key=${encodeURIComponent(cfg.apiKey)}`);
    const uploads = body.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? uploadsPlaylistFrom(channel);
    if (!uploads) throw new Error(`YouTube has no channel matching "${channel}"`);
    this.uploadsPlaylist = uploads;
    return uploads;
  }

  /** Public path: recent uploads, then their live details. Two units. */
  private async lookPublic(cfg: YouTubeConfig): Promise<{ live: boolean; startedAt: string | null; detail: string | null }> {
    const uploads = await this.resolveUploads(cfg);
    const key = encodeURIComponent(cfg.apiKey);
    const playlist = await this.json<{ items?: { contentDetails?: { videoId?: string } }[] }>(
      `${API}/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=${RECENT_UPLOADS}&key=${key}`,
    );
    const ids = (playlist.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => !!x);
    if (!ids.length) return { live: false, startedAt: null, detail: null };

    const videos = await this.json<{ items?: YouTubeVideo[] }>(
      `${API}/videos?part=snippet%2CliveStreamingDetails&id=${ids.map(encodeURIComponent).join("%2C")}&key=${key}`,
    );
    const live = (videos.items ?? []).filter(videoIsLive);
    if (!live.length) return { live: false, startedAt: null, detail: null };

    const starts = live
      .map((v) => v.liveStreamingDetails?.actualStartTime)
      .filter((x): x is string => !!x)
      .map((x) => Date.parse(x))
      .filter(Number.isFinite);
    return {
      live: true,
      startedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      detail: live.map((v) => v.snippet?.title ?? v.id ?? "").filter(Boolean).join(" + ") || null,
    };
  }

  /** OAuth path: our own broadcasts, private ones included. One unit. */
  private async lookOwn(cfg: YouTubeConfig): Promise<{ live: boolean; startedAt: string | null; detail: string | null }> {
    const token = await this.ensureAccessToken(cfg);
    const body = await this.json<{ items?: YouTubeBroadcast[] }>(
      `${API}/liveBroadcasts?part=snippet%2Cstatus&broadcastStatus=active&mine=true&maxResults=5`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const live = (body.items ?? []).filter(broadcastIsLive);
    return {
      live: live.length > 0,
      startedAt: earliestStart(live),
      detail: live.map((b) => b.snippet?.title ?? b.id ?? "").filter(Boolean).join(" + ") || null,
    };
  }

  /** Whichever way this connection is set up to ask. */
  private async look(
    cfg: YouTubeConfig,
    opts: { fresh?: boolean } = {},
  ): Promise<{ live: boolean; startedAt: string | null; detail: string | null }> {
    // The test button must not report success off a cached channel lookup made
    // with the credentials the operator is in the middle of replacing.
    if (opts.fresh) this.uploadsPlaylist = null;
    return cfg.mode === "oauth" ? this.lookOwn(cfg) : this.lookPublic(cfg);
  }

  // ── Poll ──────────────────────────────────────────────────────────────────

  protected async connect(): Promise<void> {
    if (!this.running || !this.configured) return;
    try {
      const seen = await this.look(this.cfg);
      if (!this.running) return;

      if (!this.last.connected) {
        this.resetBackoff();
        this.report("connected", "Connected to YouTube");
      }

      this.emitIfChanged({ connected: true, ...seen });
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

  override stop(): void {
    super.stop();
    this.accessToken = null;
    this.accessExpiresAt = 0;
  }
}

/** Does this config have what its own mode needs? Exported because the settings
 *  card and the service must agree about what "set up" means — a card that says
 *  ready over a service that will not start is the worst of both. */
export function configComplete(cfg: YouTubeConfig): boolean {
  return cfg.mode === "oauth"
    ? !!cfg.clientId && !!cfg.clientSecret && !!cfg.refreshToken
    : !!cfg.apiKey && !!cfg.channel;
}

export const youtubeService = new YouTubeService();
