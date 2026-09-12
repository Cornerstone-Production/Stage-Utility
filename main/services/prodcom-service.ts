// prodcom-service.ts — Subscribes to ProdCom's live transcription feed and
// broadcasts it on "prodcom:transcript" for the dashboard / transcription display.
//
// ProdCom (prodcom.io) exposes an HTTP + WebSocket Application API (default port
// 24480). It PUBLISHES ITS OWN SPECIFICATION: `GET /api/v1/openapi.yaml` is a
// complete OpenAPI 3.1 document, browsable at `/docs`. Nothing here is
// reverse-engineered — every field name below is read from that spec's
// `TranscriptEntry` and `Channel` schemas and was verified against 2.3.2 on the
// LAN. Fetch the spec from the box before changing this file; do not guess field
// names, and do not add "likely" fallbacks. An earlier version of this comment
// claimed the field names were undocumented, which is how five colour keys that
// have never existed on a transcript entry survived here as dead code.
//
// Transport: one long-lived connection to `GET /api/v1/transcript/stream`, whose
// events this normalises into a rolling buffer and re-broadcasts — the same
// pattern used for PCO/ProPresenter.

import * as http from "http";

import type { TranscriptLineDTO } from "../types/stage.js";
import { broadcast, channelInDemand } from "./broadcaster.js";
import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import { ConnectionLifecycle } from "./integration-base.js";
import { createSseReader, keepSocketAlive, parseSseBlock, SSE_MAX_BUFFER, type SseEvent } from "./sse-reader.js";

const RECONNECT_MS = 4000;
/**
 * How often TCP probes the peer once the stream goes quiet.
 *
 * This — not an application-level timer — is what detects a dead link. A
 * half-open socket (the box unplugged, its
 * switch port dropped) emits neither 'end' nor 'error', so scheduleReconnect was
 * unreachable and the panel kept reading "Streaming from host:port" while the
 * captions display showed the last line from before the drop, for the rest of
 * the service. TCP keepalive assumes nothing about the payload: a live peer's
 * kernel answers the probe even when the application has nothing to say.
 */
const SOCKET_KEEPALIVE_MS = 30_000;

/**
 * Backstop for the case keepalive cannot see: a peer whose TCP stack still
 * answers while the application has stopped producing. Set far beyond any
 * plausible silence so it cannot flap through a service — this is a last resort,
 * not the mechanism.
 */
const STREAM_IDLE_MS = 15 * 60_000;

const MAX_LINES = 100;

/**
 * How old a finalised caption may be before it is dropped from the buffer and
 * skipped on backfill.
 *
 * This is live captions, not history — History has its own records, and a
 * caption older than a few hours on a display is never wanted there. A
 * service runs roughly ninety minutes, so two services back-to-back in a
 * morning both stay visible; yesterday's does not. This horizon also bounds
 * backfill(): a reconnect legitimately re-imports the service in progress
 * from ProdCom's own history, but must not re-import a service from days ago
 * just because ProdCom's history still happens to hold it — which is exactly
 * what put Thursday's lines on a display on a later day.
 */
const LINE_MAX_AGE_MS = 4 * 60 * 60_000;

/** Page size for backfill. 200 is the spec's documented maximum; the box clamps
 *  anything larger down to it rather than erroring. */
const BACKFILL_PAGE_SIZE = 200;

/**
 * Hard stop on backfill paging.
 *
 * `GET /api/v1/transcript` is ascending from the OLDEST entry and its pagination
 * is mandatory, so "fetch until hasMore is false" is the only correct way to
 * read it — and an unbounded loop against a box whose clock is wrong (making
 * `since` match everything) would walk its entire history. Twenty pages is 4000
 * lines, far more than four hours of speech, and hitting it is logged.
 */
const BACKFILL_MAX_PAGES = 20;

/** Don't re-fetch the channel list more often than this when a transcript line
 *  arrives on a channel id we have no colour for. A channel added mid-service is
 *  rare; a line on an unknown channel arriving many times a second is not. */
const CHANNEL_REFRESH_MIN_MS = 60_000;

// Coalesce interim partials (which arrive many/sec while someone speaks) into at most
// one full-buffer broadcast per this window; finals still push immediately.
const TRANSCRIPT_THROTTLE_MS = 250;

/**
 * How long an un-updated partial may sit in the buffer before it is dropped.
 *
 * A partial is removed when a FINAL arrives on the same channel key. That is the
 * only exit, and it stops being reachable the moment the channel key changes --
 * which is what renaming or re-routing a channel in ProdCom mid-service does. The
 * final for the speech already in flight then arrives under a NEW key, the old
 * entry is never deleted, and because getBuffer() appends partials after finals
 * it is pinned to the bottom of the display for the life of the process. That is
 * exactly what happened at a kickoff: one grey line stuck under everything all
 * night, reappearing at the bottom as real lines scrolled past it.
 *
 * Partials update many times a second while somebody is speaking, so an entry
 * untouched for this long is not slow speech -- it is speech whose final went
 * somewhere else. Generous enough that a real pause mid-sentence cannot trip it.
 */
const PARTIAL_TTL_MS = 30_000;

/**
 * How often the stale-partial sweep runs while a partial is held.
 *
 * pruneStalePartials() used to run only inside getBuffer(), which only executes
 * on a broadcast or an HTTP read. In a quiet room — nobody else speaking, no
 * poll hitting the backfill endpoint — a partial that went stale by the TTL
 * above would sit on every open display until the next unrelated line from
 * anyone nudged getBuffer(). This timer is the thing that notices on its own;
 * it only runs while `partials` is non-empty, and stops the moment it empties
 * (a final, a TTL drop, a clear, or a disconnect) so a quiet integration with no
 * partial in flight has nothing ticking in the background.
 */
const PARTIAL_SWEEP_MS = 5_000;

/**
 * A partial that has been in progress this long is worth a log line even when
 * it is behaving correctly (still updating, so the TTL above never touches
 * it) — an operator watching a stuck-looking line at 9pm on a Sunday needs to
 * be able to tell "this has genuinely been open for four minutes" from "the
 * display froze". Measured from firstSeenAt, not seenAt, so it reflects how
 * long the CHANNEL has been occupied, not how recently it last changed.
 */
const PARTIAL_LOG_AFTER_MS = 60_000;
/** How often the still-open log repeats for a partial that keeps surviving. */
const PARTIAL_LOG_REPEAT_MS = 5 * 60_000;

/** `source` on a TranscriptEntry: what produced the line. Only `audio` is
 *  somebody speaking; see shouldCaption(). */
type EntrySource = "audio" | "typed" | "automation";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" && v.trim() ? v : null;
}
function bool(o: Record<string, unknown>, k: string): boolean | null {
  const v = o[k];
  return typeof v === "boolean" ? v : null;
}

/**
 * ISO 8601 to WHOLE SECONDS, which is the only form `?since=` accepts.
 *
 * ProdCom 2.3.2 parses `2026-09-11T00:00:00Z` and `2026-09-11T00:00:00+00:00`
 * and filters correctly. Given `2026-09-11T00:00:00.000Z` — exactly what
 * `Date#toISOString()` returns — it does not error, does not warn, and silently
 * ignores the parameter: `totalCount` comes back as the whole 3001-row history
 * and the first page is the oldest entry, five days old. The four-hour filter
 * then throws all fifty rows away and the display stays empty. Verified against
 * the live box: `.000Z` → totalCount 3001, `Z` → totalCount 387.
 */
function sinceParam(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Normalize a raw color value to a CSS color string, or null. Accepts hex with
 *  or without a leading "#" (3/4/6/8 digits) and passes through named colors. */
function normalizeColor(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^#?[0-9a-f]{3,8}$/i.test(s)) return s.startsWith("#") ? s : `#${s}`;
  return /^[a-z]+$/i.test(s) ? s : null; // CSS named color, else ignore
}

/** One channel's in-progress partial, plus the bookkeeping the long-lived-
 *  partial diagnostics below read. */
type PartialEntry = {
  line: TranscriptLineDTO;
  /** OUR receive time of the last CHANGE (text or id differed) — drives the TTL. */
  seenAt: number;
  /** OUR receive time this channel's partial first appeared — drives the
   *  "in progress for Ns" diagnostic, independent of whether it keeps changing. */
  firstSeenAt: number;
  /** Identical re-sends (same id, same text) since firstSeenAt. */
  resendsUnchanged: number;
  /** Re-sends where the text actually differed from the previous one. */
  textChanges: number;
  /** Last time the "in progress" log fired for this entry, or null if never. */
  lastLoggedAt: number | null;
};

/** One finalised line plus OUR receive time — bookkeeping private to this
 *  service, the same way PartialEntry keeps its fields off the DTO the
 *  renderer sees. Only read when the line's own `at` (ProdCom's timestamp)
 *  doesn't parse, as the fallback age reference for LINE_MAX_AGE_MS. */
type FinalEntry = {
  line: TranscriptLineDTO;
  receivedAt: number;
};

/** What one backfill run did. Returned rather than logged in place so the caller
 *  owns the operator-facing line and a failure is not swallowed. */
export type BackfillResult = {
  added: number;
  skipped: number;
  pages: number;
  /** Set when a page failed; `added` still reports what landed before it. */
  error?: string;
};

/** What `/api/v1/channels` says about one channel. The colour lives HERE — a
 *  transcript entry has never carried one. */
type ChannelMeta = { name: string | null; color: string | null };

export class ProdComService extends ConnectionLifecycle {
  /** Wall clock, overridable so a test can age a partial without waiting 30s. */
  protected now(): number {
    return Date.now();
  }

  private host: string | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;

  private req: http.ClientRequest | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** id → {name, colour} from GET /api/v1/channels. */
  private channels = new Map<string, ChannelMeta>();
  private channelsFetchedAt = 0;
  private channelRefreshInFlight = false;

  /** How many entries of each non-audio `source` this connection has skipped —
   *  the count exists so the log line fires once per kind, not once per line. */
  private skippedSources = new Map<string, number>();

  private seq = 0;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptDirty = false;

  /** Finalised lines (rolling) + the current partial per channel.
   *
   *  `seenAt` is OUR receive time, not the payload's -- the timestamp in a
   *  ProdCom event is whatever that box's clock said, and this is used to decide
   *  whether an entry has gone stale, which must not depend on a peer's clock. */
  private finals: FinalEntry[] = [];
  private partials = new Map<string, PartialEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Channel keys already logged as "final with no matching partial" since the
   *  current connection started — one log per key per connection, not one per
   *  occurrence, or a channel stuck in that state would spam the log forever. */
  private orphanFinalLogged = new Set<string>();

  /** Test seam: whether the stale-partial sweep is currently armed. */
  protected get partialSweepActive(): boolean {
    return this.sweepTimer !== null;
  }

  /**
   * Test seam for the reconnect delay.
   *
   * The tests drive real sockets against a real local ProdCom stub, so
   * `t.mock.timers` is not an option; overriding this lets a test exercise the
   * genuine reconnect path in milliseconds rather than seconds.
   */
  protected get reconnectMs(): number {
    return RECONNECT_MS;
  }

  /** Test seam: the REST prime (channels, then backfill) the current connection
   *  kicked off, so a test can await the same work instead of polling. */
  protected priming: Promise<void> = Promise.resolve();

  constructor() {
    super("prodcom", "prodcom:transcript");
  }

  protected get configured(): boolean {
    return !!this.host && !!this.port;
  }

  configure(host: string, port: number, apiKey: string | null): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.apiKey = apiKey?.trim() || null;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[prodcom] connecting ${this.host}:${this.port}`);
    super.start();
  }

  protected override teardown(): void {
    this.clearIdleWatchdog();
    this.req?.destroy();
    this.req = null;
    this.skippedSources.clear();
    // In-flight speech does not survive the stream. Whatever was mid-utterance
    // when the connection went will be re-sent or finalised on the other side; an
    // orphan kept here would sit under every real line until a restart. Finals are
    // deliberately kept, so a reconnect does not blank a display mid-service.
    this.partials.clear();
    this.syncPartialSweep();
    // A new connection is a new epoch for the renamed-channel diagnostic below —
    // whatever channel keys existed before this reconnect are gone with it.
    this.orphanFinalLogged.clear();
  }

  /** Restart the silence timer. Called on connect and on every chunk. */
  private armIdleWatchdog(): void {
    this.clearIdleWatchdog();
    this.idleTimer = setTimeout(() => {
      console.warn(`[prodcom] no transcript data for ${STREAM_IDLE_MS / 1000}s — treating the stream as dead`);
      this.report("error", "Transcript stream went silent — reconnecting");
      this.req?.destroy();
      this.req = null;
      this.scheduleReconnect();
    }, STREAM_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleWatchdog(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Drop partials nothing has updated for PARTIAL_TTL_MS. Returns whether any went. */
  private pruneStalePartials(): boolean {
    const cutoff = this.now() - PARTIAL_TTL_MS;
    let dropped = false;
    for (const [ch, entry] of this.partials) {
      if (entry.seenAt > cutoff) continue;
      this.partials.delete(ch);
      dropped = true;
      console.log(`[prodcom] dropped a stale partial on channel ${scrub(ch)} — no final arrived`);
    }
    this.syncPartialSweep();
    return dropped;
  }

  /** OUR reference time for a final: its own `at` when parseable, else the
   *  time we received it (see FinalEntry). */
  private finalTimestamp(entry: FinalEntry): number {
    const parsed = Date.parse(entry.line.at);
    return Number.isNaN(parsed) ? entry.receivedAt : parsed;
  }

  /** Drop finalised lines older than LINE_MAX_AGE_MS. Returns whether any went. */
  private pruneStaleFinals(): boolean {
    const cutoff = this.now() - LINE_MAX_AGE_MS;
    const before = this.finals.length;
    this.finals = this.finals.filter((e) => this.finalTimestamp(e) >= cutoff);
    const dropped = before - this.finals.length;
    if (dropped > 0) console.log(`[prodcom] dropped ${dropped} line(s) older than 4h`);
    this.syncPartialSweep();
    return dropped > 0;
  }

  /**
   * Arm the sweep timer while a partial is held OR a final is in the buffer,
   * disarm it the moment both are empty. Called after every mutation of
   * `partials` or `finals` so the timer's lifetime tracks the buffer's
   * emptiness exactly, rather than depending on every call site to remember
   * every half. Finals age out on their own four-hour horizon (LINE_MAX_AGE_MS)
   * the same way partials age out on PARTIAL_TTL_MS, so both need the same
   * background sweep in a quiet room where nothing else calls getBuffer().
   */
  private syncPartialSweep(): void {
    if (this.partials.size > 0 || this.finals.length > 0) {
      if (this.sweepTimer) return;
      this.sweepTimer = setInterval(() => {
        const droppedPartials = this.pruneStalePartials();
        const droppedFinals = this.pruneStaleFinals();
        this.logLongLivedPartials();
        if (droppedPartials || droppedFinals) this.flushTranscript();
      }, PARTIAL_SWEEP_MS);
      this.sweepTimer.unref?.();
    } else if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Log a channel whose partial has been open a long time, whether or not it is
   * behaving correctly — a live monologue and a stuck line both look the same
   * from the outside ("still there"), and this is what tells them apart after
   * the fact. Fires once at PARTIAL_LOG_AFTER_MS, then at most once every
   * PARTIAL_LOG_REPEAT_MS while the same entry survives.
   */
  private logLongLivedPartials(): void {
    const now = this.now();
    for (const [ch, entry] of this.partials) {
      const age = now - entry.firstSeenAt;
      if (age < PARTIAL_LOG_AFTER_MS) continue;
      if (entry.lastLoggedAt != null && now - entry.lastLoggedAt < PARTIAL_LOG_REPEAT_MS) continue;
      entry.lastLoggedAt = now;
      const lastUpdateAgo = Math.round((now - entry.seenAt) / 1000);
      console.log(
        `[prodcom] partial on channel ${scrub(ch)} in progress for ${Math.round(age / 1000)}s — ` +
          `${entry.resendsUnchanged} unchanged re-sends, ${entry.textChanges} text changes, ` +
          `last update ${lastUpdateAgo}s ago, ${entry.line.text.length} chars`,
      );
    }
  }

  /**
   * Empty the transcript.
   *
   * Both halves, because the stuck-line case needs the partials gone and an
   * operator asking for a clear means the screen, which is the finals. Broadcasts
   * unconditionally: the point is that the display goes empty NOW.
   *
   * Logs each partial being discarded BEFORE clearing — the operator's button
   * is the only cure for the stuck-line bug this file guards against, so the
   * moment it's pressed is the moment to record which channel was stuck, for
   * how long, and how it behaved, in case it happens again.
   */
  clearTranscript(): void {
    const now = this.now();
    for (const [ch, entry] of this.partials) {
      const age = Math.round((now - entry.firstSeenAt) / 1000);
      console.log(
        `[prodcom] transcript cleared by operator: ${this.finals.length} finals, ${this.partials.size} partials; ` +
          `partial ch=${scrub(ch)} age=${age}s unchanged-resends=${entry.resendsUnchanged} text-changes=${entry.textChanges}`,
      );
    }
    this.finals = [];
    this.partials.clear();
    this.syncPartialSweep();
    broadcast("prodcom:transcript", this.getBuffer());
    console.log("[prodcom] transcript cleared");
  }

  /** Current rolling buffer (finals + active partials), oldest → newest. */
  getBuffer(): TranscriptLineDTO[] {
    this.pruneStalePartials();
    this.pruneStaleFinals();
    return [...this.finals.map((e) => e.line), ...[...this.partials.values()].map((e) => e.line)];
  }

  /**
   * One-shot connectivity check for the Integrations "Test connection" button.
   *
   * Hits `/api/v1/status`, not the transcript stream: it is the endpoint the spec
   * provides for exactly this, it answers immediately instead of holding a
   * connection open, and its body names the version and channel count — which is
   * what an operator needs to know they reached the right box.
   */
  async test(host: string, port: number, apiKey: string | null): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          host,
          port,
          path: "/api/v1/status",
          headers: { ...this.authHeaders(apiKey), Accept: "application/json" },
          timeout: 4000,
        },
        (res) => {
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) {
            res.destroy();
            resolve({ ok: false, message: `ProdCom returned HTTP ${code}` });
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => {
            const data = asRecord(asRecord(safeJson(body))?.["data"]);
            const version = data ? str(data, "version") : null;
            const count = data && typeof data["channelCount"] === "number" ? data["channelCount"] : null;
            const detail = [version && `ProdCom ${version}`, count != null && `${count} channels`]
              .filter(Boolean)
              .join(", ");
            resolve({
              ok: true,
              message: detail ? `${detail} at ${host}:${port}` : `Connected to ProdCom at ${host}:${port}`,
            });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ ok: false, message: e.message }));
    });
  }

  /**
   * The one auth scheme ProdCom declares.
   *
   * The spec's `components.securitySchemes` has exactly one entry, `bearerAuth`
   * (`type: http, scheme: bearer`): "include the API key in the Authorization
   * header: `Bearer <key>`". This used to send `X-API-Key` alongside it on the
   * theory that "the auth header name isn't documented". It is documented, and
   * it is not that, so the second copy of the operator's pre-shared key stops
   * going out on every request.
   *
   * Auth only — every caller adds its own Accept, rather than this hard-coding
   * `Accept: text/event-stream` and having it ride along on the JSON reads.
   */
  private authHeaders(apiKey: string | null): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /**
   * ProdCom streams live captions, so it keeps its flat 4s retry rather than the
   * base's exponential window-aware back-off: a transcript that reconnects
   * minutes late has already missed the sentence it existed to show.
   */
  protected override scheduleReconnect(): void {
    if (!this.running) return;
    this.scheduleIn(this.reconnectMs);
  }

  protected async connect(): Promise<void> {
    this.clearIdleWatchdog();
    if (!this.running || !this.host || !this.port) return;
    this.connectSse(this.host, this.port);
  }

  private connectSse(host: string, port: number): void {
    const req = http.get(
      {
        host,
        port,
        path: "/api/v1/transcript/stream",
        headers: { ...this.authHeaders(this.apiKey), Accept: "text/event-stream" },
      },
      (res) => {
        const code = res.statusCode ?? 0;
        if (code < 200 || code >= 300) {
          res.destroy();
          this.report("error", `ProdCom HTTP ${code}`);
          this.scheduleReconnect();
          return;
        }
        this.report("connected", `Streaming from ${host}:${port}`);
        this.priming = this.primeFromRest(host, port);
        res.setEncoding("utf8");
        this.armIdleWatchdog();

        // Parse text/event-stream via the shared reader — a new one per
        // connection, so a partial event does not survive a reconnect. It caps the
        // accumulation buffer and resyncs at the next separator on overflow; the
        // log line is ours because an operator needs to know WHICH stream lost
        // data.
        const reader = createSseReader({
          onOverflow: () =>
            console.warn(`[prodcom] transcript buffer exceeded ${SSE_MAX_BUFFER} bytes — resyncing`),
        });
        res.on("data", (chunk: string) => {
          this.armIdleWatchdog();
          for (const event of reader.push(chunk)) this.handleSseEvent(event);
        });
        res.on("end", () => {
          this.clearIdleWatchdog();
          this.report("disconnected", null);
          this.scheduleReconnect();
        });
        res.on("error", () => {
          this.clearIdleWatchdog();
          this.scheduleReconnect();
        });
      },
    );
    this.req = req;
    // The real liveness check — see SOCKET_KEEPALIVE_MS.
    keepSocketAlive(req, SOCKET_KEEPALIVE_MS);
    req.on("error", (e) => {
      // A watchdog armed by the dying stream must not outlive it, or it can
      // destroy the NEXT request while it is still connecting.
      this.clearIdleWatchdog();
      this.report("error", `Can't reach ${host}:${port} — ${e.message}`);
      this.scheduleReconnect();
    });
  }

  // One SSE event block ("event: x\ndata: {...}"). Kept as the (string) entry
  // point the tests drive, and it goes through the same shared block parser the
  // live stream does.
  protected handleEvent(raw: string): void {
    const event = parseSseBlock(raw);
    if (event) this.handleSseEvent(event);
  }

  // (event:/id: names ignored — transcript framing is carried in the payload)
  private handleSseEvent({ data: payload }: SseEvent): void {
    if (!payload || payload === "[DONE]") return;
    if (process.env.PRODCOM_DEBUG) console.log(`[prodcom] RAW ${payload}`);
    const entry = asRecord(safeJson(payload));
    if (!entry) {
      // Every SSE event on this endpoint is "a JSON object representing a new,
      // updated, or completed transcript entry" per the spec. Anything else is
      // not a caption and must not reach a stage wall as one.
      console.warn(`[prodcom] transcript stream sent a frame that is not JSON, ignoring it (${payload.length} bytes)`);
      return;
    }
    this.acceptEntry(entry);
  }

  // ── Entry handling ────────────────────────────────────────────────────────

  /** Normalise one TranscriptEntry and, if it is speech, put it in the buffer. */
  private acceptEntry(entry: Record<string, unknown>): void {
    const line = this.normalizeLine(entry);
    if (!line) return;
    if (!this.shouldCaption(entry)) return;
    this.ingest(line);
  }

  /**
   * Whether an entry belongs on a caption display.
   *
   * `source` is required on every TranscriptEntry and is one of `audio`, `typed`
   * or `automation`. Only the first is somebody speaking. The other two were
   * rendered identically until now, so an operator typing "cam 2 go wide" into a
   * comms channel put that sentence on the stage and lobby walls as though it had
   * been said aloud. An entry with no `source` at all is treated as speech — a
   * build that predates the field should not lose its captions.
   */
  private shouldCaption(entry: Record<string, unknown>): boolean {
    const source = str(entry, "source") as EntrySource | null;
    if (source === null || source === "audio") return true;
    const seen = (this.skippedSources.get(source) ?? 0) + 1;
    this.skippedSources.set(source, seen);
    if (seen === 1) {
      console.log(`[prodcom] not captioning "${source}" entries — they are not spoken audio`);
    }
    return false;
  }

  /**
   * One TranscriptEntry → one TranscriptLineDTO.
   *
   * Field names are the spec's, verified against 3001 rows on 2.3.2:
   *   { id, channelId, channelName?, text, source, inProgress, date,
   *     completeDate?, seenDate?, hasBeenSeen, translatedText?,
   *     triggeredAutomations? }
   * `inProgress: true` = interim/partial; the line is final when it is false.
   *
   * `triggeredAutomations` is deliberately ignored: it names the automations a
   * line fired, which is information for ProdCom's own UI, not for a caption.
   */
  private normalizeLine(entry: Record<string, unknown>): TranscriptLineDTO | null {
    const text = str(entry, "text");
    if (text == null) return null;
    const channel = str(entry, "channelId");

    // Colour and the display name come from GET /api/v1/channels, keyed by
    // channel id. A transcript entry has never carried a colour — this file used
    // to probe five different key names for one and every channel therefore fell
    // through to the UI's deterministic colour. The channel record is also the
    // CURRENT name, where the entry's `channelName` is denormalised at write time
    // and goes stale the moment a channel is renamed mid-service.
    const meta = channel ? this.channels.get(channel) : undefined;
    const channelName = meta?.name ?? str(entry, "channelName");
    const color = meta?.color ?? null;
    if (channel && !meta) this.refreshChannelsSoon();

    const inProgress = bool(entry, "inProgress");
    const isFinal = inProgress == null ? true : !inProgress;
    const id = str(entry, "id") ?? `t${++this.seq}`;
    const at = str(entry, "completeDate") ?? str(entry, "date") ?? new Date().toISOString();
    return { id, channel, channelName, color, text, isFinal, at };
  }

  private ingest(line: TranscriptLineDTO): void {
    const ch = line.channel ?? "_";
    if (line.isFinal) {
      const hadPartial = this.partials.has(ch);
      // The renamed-channel case from the incident this file guards against: a
      // final lands under a key with no partial to resolve, while OTHER
      // channels are mid-utterance. Once per channel per connection, or a
      // channel stuck in this state would spam the log on every final.
      if (!hadPartial && this.partials.size > 0 && !this.orphanFinalLogged.has(ch)) {
        this.orphanFinalLogged.add(ch);
        console.log(
          `[prodcom] final on channel ${scrub(ch)} with no partial in flight; ` +
            `${this.partials.size} partial(s) live on other channels`,
        );
      }
      this.partials.delete(ch);
      this.syncPartialSweep();
      this.addFinal(line);
      this.flushTranscript(); // finals land immediately
    } else {
      // A re-send of the SAME partial (identical id and text) is not progress —
      // ProdCom re-emitting an interim result on a keepalive, or a recogniser
      // stalled on an open mic, both look like this. Only a genuine change
      // refreshes seenAt; an unchanged re-send keeps the original arrival time,
      // or the TTL below would never elapse no matter how long it sat there.
      const existing = this.partials.get(ch);
      const unchanged = !!existing && existing.line.id === line.id && existing.line.text === line.text;
      const now = this.now();
      this.partials.set(ch, {
        line,
        seenAt: unchanged ? existing!.seenAt : now,
        firstSeenAt: existing ? existing.firstSeenAt : now,
        resendsUnchanged: (existing?.resendsUnchanged ?? 0) + (unchanged ? 1 : 0),
        textChanges: (existing?.textChanges ?? 0) + (existing && !unchanged ? 1 : 0),
        lastLoggedAt: existing?.lastLoggedAt ?? null,
      });
      this.syncPartialSweep();
      this.scheduleTranscript(); // interim partials arrive many/sec — coalesce them
    }
  }

  private flushTranscript(): void {
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = null;
    }
    this.transcriptDirty = false;
    // Skip the full-buffer spread + push when nothing consumes the transcript.
    //
    // channelInDemand, not channelHasSubscribers: the prodcom.phrase-said trigger
    // reads this channel from inside the process, so a browser-only check meant a
    // phrase rule never fired unless somebody happened to have a transcription
    // display open — which on an unattended box is never.
    if (channelInDemand("prodcom:transcript")) broadcast("prodcom:transcript", this.getBuffer());
  }

  private scheduleTranscript(): void {
    this.transcriptDirty = true;
    if (this.transcriptTimer) return;
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null;
      if (this.transcriptDirty) this.flushTranscript();
    }, TRANSCRIPT_THROTTLE_MS);
  }

  // Append a finalised line, replacing any existing one with the same id (so a
  // backfilled line and a streamed update of it don't both appear).
  private addFinal(line: TranscriptLineDTO): void {
    const entry: FinalEntry = { line, receivedAt: this.now() };
    const at = this.finals.findIndex((e) => e.line.id === line.id);
    if (at !== -1) this.finals[at] = entry;
    else this.finals.push(entry);
    if (this.finals.length > MAX_LINES) this.finals.splice(0, this.finals.length - MAX_LINES);
    this.syncPartialSweep();
  }

  // ── REST priming: channel colours, then the transcript so far ─────────────

  /**
   * What a freshly-opened connection needs from REST.
   *
   * Channels FIRST and awaited, so the backfilled lines carry their colours on
   * the very first broadcast rather than arriving grey and correcting later.
   */
  private async primeFromRest(host: string, port: number): Promise<void> {
    await this.fetchChannels(host, port);
    const result = await this.backfill(host, port);
    if (result.error) {
      console.warn(
        `[prodcom] backfill failed after ${result.pages} page(s) (${result.error}) — ` +
          `${result.added} line(s) landed; the live stream is unaffected`,
      );
    } else if (result.added > 0 || result.pages > 1) {
      console.log(`[prodcom] backfill: ${result.added} line(s) over ${result.pages} page(s)`);
    }
  }

  /**
   * Fetch `/api/v1/channels` and key name + colour by channel id.
   *
   * Nothing pushes a channel change, so this is a REST read on connect plus a
   * throttled refresh when a line turns up on an id we have never seen.
   */
  private async fetchChannels(host: string, port: number): Promise<void> {
    let body: string;
    try {
      body = await this.getJson(host, port, "/api/v1/channels");
    } catch (e) {
      console.warn(
        `[prodcom] channel list unavailable (${errorMessage(e)}) — ` +
          `captions fall back to per-channel colours chosen by the display`,
      );
      return;
    }
    const rows = asRecord(safeJson(body))?.["data"];
    if (!Array.isArray(rows)) {
      console.warn("[prodcom] channel list had no data array — captions fall back to display-chosen colours");
      return;
    }
    const next = new Map<string, ChannelMeta>();
    for (const row of rows) {
      const rec = asRecord(row);
      const id = rec && str(rec, "id");
      if (!rec || !id) continue;
      next.set(id, { name: str(rec, "name"), color: normalizeColor(str(rec, "color")) });
    }
    this.channels = next;
    this.channelsFetchedAt = this.now();
  }

  /** A line arrived on an unknown channel id. Re-read the list, at most once per
   *  CHANNEL_REFRESH_MIN_MS, so a channel added mid-service gets its colour. */
  private refreshChannelsSoon(): void {
    if (this.channelRefreshInFlight) return;
    if (this.now() - this.channelsFetchedAt < CHANNEL_REFRESH_MIN_MS) return;
    const host = this.host;
    const port = this.port;
    if (!host || !port) return;
    this.channelRefreshInFlight = true;
    // Stamp before the fetch, or a box that keeps failing would be re-asked on
    // every single line.
    this.channelsFetchedAt = this.now();
    void this.fetchChannels(host, port).finally(() => {
      this.channelRefreshInFlight = false;
    });
  }

  /**
   * Prime the buffer from ProdCom's own history so a display opened mid-service
   * shows prior lines immediately.
   *
   * `GET /api/v1/transcript` is ascending FROM THE OLDEST ENTRY and its
   * pagination is mandatory. Called with no parameters — which is what this did
   * until now — it returns the oldest 50 rows of about 3000, five days old, and
   * applyBackfillRows() then discards all fifty as older than the horizon. A
   * display opened mid-service showed nothing until somebody spoke.
   *
   * So: `since` narrows it server-side (mind sinceParam() — the millisecond form
   * is silently ignored), `limit` takes the spec's maximum, and `offset` walks
   * every page `hasMore` reports rather than assuming one is enough.
   */
  private async backfill(host: string, port: number): Promise<BackfillResult> {
    const since = sinceParam(this.now() - LINE_MAX_AGE_MS);
    const rows: unknown[] = [];
    let pages = 0;
    let error: string | undefined;

    for (let offset = 0; pages < BACKFILL_MAX_PAGES; offset += BACKFILL_PAGE_SIZE) {
      const path =
        `/api/v1/transcript?since=${encodeURIComponent(since)}` +
        `&limit=${BACKFILL_PAGE_SIZE}&offset=${offset}`;
      let body: string;
      try {
        body = await this.getJson(host, port, path);
      } catch (e) {
        error = errorMessage(e);
        break;
      }
      pages++;
      const parsed = asRecord(safeJson(body));
      const data = parsed?.["data"];
      if (!Array.isArray(data)) {
        error = "response had no data array";
        break;
      }
      rows.push(...data);
      const meta = asRecord(parsed?.["meta"]);
      if (data.length === 0 || meta?.["hasMore"] !== true) break;
      if (pages === BACKFILL_MAX_PAGES) {
        console.warn(
          `[prodcom] backfill stopped at the ${BACKFILL_MAX_PAGES}-page cap — ` +
            `ProdCom reports more history since ${since} than ${BACKFILL_MAX_PAGES * BACKFILL_PAGE_SIZE} lines`,
        );
      }
    }

    const applied = this.applyBackfillRows(rows);
    return { added: applied.added, skipped: applied.skipped, pages, error };
  }

  /** One GET, resolving the body or rejecting with a reason the caller can log. */
  private getJson(host: string, port: number, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host, port, path, headers: { ...this.authHeaders(this.apiKey), Accept: "application/json" }, timeout: 4000 },
        (res) => {
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) {
            res.resume();
            reject(new Error(`HTTP ${code}`));
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => resolve(body));
          res.on("error", (e) => reject(e));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    });
  }

  /**
   * Apply ProdCom's own transcript history to the buffer on (re)connect.
   *
   * Rows older than LINE_MAX_AGE_MS are skipped even though `since` already asked
   * the server for the same window. That is deliberate belt-and-braces, not
   * duplication: `since` is silently ignored by 2.3.2 when the timestamp carries
   * milliseconds (see sinceParam), the parameter did not exist at all on older
   * builds, and a box whose clock is days off will happily answer with anything.
   * This filter is what stops Thursday's sermon reaching a display on Sunday in
   * every one of those cases. Protected (not private) so a test can drive it
   * directly without a real ProdCom host.
   */
  protected applyBackfillRows(rows: unknown[]): { added: number; skipped: number } {
    const cutoff = this.now() - LINE_MAX_AGE_MS;
    let added = 0;
    let skipped = 0;
    for (const row of rows) {
      const entry = asRecord(row);
      if (!entry) continue;
      const line = this.normalizeLine(entry);
      if (!line?.isFinal) continue;
      if (!this.shouldCaption(entry)) continue;
      const parsed = Date.parse(line.at);
      const at = Number.isNaN(parsed) ? this.now() : parsed;
      if (at < cutoff) {
        skipped++;
        continue;
      }
      this.addFinal(line);
      added++;
    }
    if (skipped > 0) {
      console.log(`[prodcom] backfill skipped ${skipped} line(s) older than 4h`);
    }
    if (added > 0) broadcast("prodcom:transcript", this.getBuffer());
    return { added, skipped };
  }
}

/** JSON.parse that returns null instead of throwing. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const prodcomService = new ProdComService();
