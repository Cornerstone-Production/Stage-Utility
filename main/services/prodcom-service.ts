// prodcom-service.ts — Subscribes to ProdCom's live transcription feed and
// broadcasts it on "prodcom:transcript" for the dashboard / transcription display.
//
// ProdCom (prodcom.io) exposes an HTTP Application API (default port 24480) with a
// purpose-built transcript SSE stream: GET /api/v1/transcript/stream. We hold one
// long-lived connection to it, normalise each event to a TranscriptLine, keep a
// rolling buffer, and re-broadcast — the same pattern used for PCO/ProPresenter.
//
// The exact JSON field names of transcript events aren't in ProdCom's public docs
// (capture them from the app's in-app /docs on the network). So parsing here is
// centralised + defensive: it tries several likely field names and degrades to raw
// text, never throwing. Tune `normalizeLine()` once the real shape is known.

import * as http from "http";

import type { TranscriptLineDTO } from "../types/stage.js";
import { broadcast, channelInDemand } from "./broadcaster.js";
import { scrub } from "./scrub.js";
import { ConnectionLifecycle } from "./integration-base.js";

const RECONNECT_MS = 4000;
/** Cap on the SSE accumulation buffer — a stream that never terminates an event
 *  would otherwise grow it without bound over weeks of uptime. */
const MAX_STREAM_BUFFER = 256_000;
/**
 * How often TCP probes the peer once the stream goes quiet.
 *
 * This — not an application-level timer — is what detects a dead link. A
 * half-open socket (the box unplugged, its switch port dropped) emits neither
 * 'end' nor 'error', so scheduleReconnect was unreachable and the panel kept
 * reading "Streaming from host:port" while the captions display showed the last
 * line from before the drop, for the rest of the service.
 *
 * Deliberately NOT a silence timer over transcript data. ProdCom's protocol is
 * reverse-engineered here (the field names are not in its public docs), so
 * whether it emits an SSE keepalive is unverified — and if it does not, a
 * data-silence timer would fire on every quiet stretch: an instrumental set, a
 * weeknight, any gap longer than the threshold. That is a reconnect every
 * interval, all week, with the panel flapping green/red each time. TCP keepalive
 * assumes nothing about the payload: a live peer's kernel answers the probe even
 * when the application has nothing to say.
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

function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}
function firstString(obj: unknown, keys: string[]): string | null {
  for (const k of keys) {
    const v = pick(obj, k);
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}
function firstBool(obj: unknown, keys: string[]): boolean | null {
  for (const k of keys) {
    const v = pick(obj, k);
    if (typeof v === "boolean") return v;
  }
  return null;
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

  private seq = 0;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptDirty = false;

  /** Finalised lines (rolling) + the current partial per channel.
   *
   *  `seenAt` is OUR receive time, not the payload's -- the timestamp in a
   *  ProdCom event is whatever that box's clock said, and this is used to decide
   *  whether an entry has gone stale, which must not depend on a peer's clock. */
  private finals: TranscriptLineDTO[] = [];
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

  /**
   * Arm the sweep timer while a partial is held, disarm it the moment none is.
   * Called after every mutation of `partials` so the timer's lifetime tracks
   * the map's emptiness exactly, rather than depending on every call site to
   * remember both halves.
   */
  private syncPartialSweep(): void {
    if (this.partials.size > 0) {
      if (this.sweepTimer) return;
      this.sweepTimer = setInterval(() => {
        const dropped = this.pruneStalePartials();
        this.logLongLivedPartials();
        if (dropped) this.flushTranscript();
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
    return [...this.finals, ...[...this.partials.values()].map((e) => e.line)];
  }

  /** One-shot connectivity check for the Integrations "Test connection" button. */
  async test(host: string, port: number, apiKey: string | null): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      const req = http.get(
        { host, port, path: "/api/v1/transcript/stream", headers: this.authHeaders(apiKey), timeout: 4000 },
        (res) => {
          const code = res.statusCode ?? 0;
          res.destroy();
          if (code >= 200 && code < 300) resolve({ ok: true, message: `Connected to ProdCom at ${host}:${port}` });
          else resolve({ ok: false, message: `ProdCom returned HTTP ${code}` });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ ok: false, message: e.message }));
    });
  }

  private authHeaders(apiKey: string | null): Record<string, string> {
    const h: Record<string, string> = { Accept: "text/event-stream" };
    // Auth header name isn't documented — send the two common forms when a key is
    // set (servers ignore unknown headers). Narrow this once captured in-app.
    if (apiKey) {
      h["Authorization"] = `Bearer ${apiKey}`;
      h["X-API-Key"] = apiKey;
    }
    return h;
  }

  /**
   * ProdCom streams live captions, so it keeps its flat 4s retry rather than the
   * base's exponential window-aware back-off: a transcript that reconnects
   * minutes late has already missed the sentence it existed to show.
   */
  protected override scheduleReconnect(): void {
    if (!this.running) return;
    this.scheduleIn(RECONNECT_MS);
  }

  protected async connect(): Promise<void> {
    this.clearIdleWatchdog();
    if (!this.running || !this.host || !this.port) return;
    const host = this.host;
    const port = this.port;

    const req = http.get(
      { host, port, path: "/api/v1/transcript/stream", headers: this.authHeaders(this.apiKey) },
      (res) => {
        const code = res.statusCode ?? 0;
        if (code < 200 || code >= 300) {
          res.destroy();
          this.report("error", `ProdCom HTTP ${code}`);
          this.scheduleReconnect();
          return;
        }
        this.report("connected", `Streaming from ${host}:${port}`);
        this.backfill(host, port);
        res.setEncoding("utf8");
        this.armIdleWatchdog();

        // Parse text/event-stream: accumulate until a blank line ends an event.
        let buf = "";
        res.on("data", (chunk: string) => {
          this.armIdleWatchdog();
          buf += chunk;
          // A stream that never sends the blank-line terminator would otherwise
          // grow this without bound in a process that stays up for weeks, and
          // re-split an ever-longer string on every chunk. The Spectera SSE parser
          // has carried this cap for a while; this one did not.
          if (buf.length > MAX_STREAM_BUFFER) {
            // Drop back to the last line boundary rather than to "". Clearing
            // mid-event leaves a tail that the next "\n\n" terminates, and
            // handleEvent treats an unparseable block as a finalised line — so a
            // truncated fragment could reach the wall as a caption.
            console.warn(`[prodcom] transcript buffer exceeded ${MAX_STREAM_BUFFER} bytes — resyncing`);
            const lastBreak = buf.lastIndexOf("\n");
            buf = lastBreak === -1 ? "" : buf.slice(lastBreak + 1);
          }
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            this.handleEvent(raw);
          }
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
    req.on("socket", (socket) => socket.setKeepAlive(true, SOCKET_KEEPALIVE_MS));
    req.on("error", (e) => {
      // A watchdog armed by the dying stream must not outlive it, or it can
      // destroy the NEXT request while it is still connecting.
      this.clearIdleWatchdog();
      this.report("error", `Can't reach ${host}:${port} — ${e.message}`);
      this.scheduleReconnect();
    });
  }

  // One SSE event block ("event: x\ndata: {...}"). data may be JSON or plain text.
  protected handleEvent(raw: string): void {
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      // (event:/id: lines ignored — transcript framing is carried in the payload)
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") return;

    // Diagnostic: with PRODCOM_DEBUG set, log every raw transcript frame exactly
    // as ProdCom sent it — the ground truth for confirming whether a per-channel
    // color field exists and its key name. Enable with `PRODCOM_DEBUG=1`.
    if (process.env.PRODCOM_DEBUG) {
      console.log(`[prodcom] RAW ${payload}`);
    }

    let parsed: unknown = payload;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // plain-text data — treat the whole thing as a finalised line
    }
    const line = this.normalizeLine(parsed);
    if (line) this.ingest(line);
  }

  // Normalisation — verified against ProdCom v2.3.1 (/api/v1/transcript items):
  //   { id, text, channelId, channelName, inProgress, date, completeDate, source, ... }
  // `inProgress: true` = interim/partial; the line is final when it's false.
  // Kept defensive (extra field-name fallbacks) so other versions still parse.
  private normalizeLine(data: unknown): TranscriptLineDTO | null {
    if (typeof data === "string") {
      if (!data.trim()) return null;
      return { id: `t${++this.seq}`, channel: null, channelName: null, color: null, text: data, isFinal: true, at: new Date().toISOString() };
    }
    const text = firstString(data, ["text", "transcript", "content", "line", "value"]);
    if (text == null) return null;
    const channel = firstString(data, ["channelId", "channel", "channel_id", "channelIndex"]);
    const channelName = firstString(data, ["channelName", "channel_name", "name", "label"]);
    // Use ProdCom's own channel color when it sends one; null → UI falls back to
    // a deterministic per-channel color. (Field name unconfirmed — kept defensive;
    // PRODCOM_DEBUG logs raw frames so the real key can be confirmed on site.)
    const color = normalizeColor(
      firstString(data, ["color", "color", "channelColor", "channel_color", "hexColor", "hex"]),
    );

    // ProdCom's flag is `inProgress` (true = partial). Fall back to other spellings.
    const inProgress = firstBool(data, ["inProgress", "in_progress", "partial", "interim"]);
    const isFinalRaw = firstBool(data, ["isFinal", "final", "is_final", "completed"]);
    const status = firstString(data, ["status", "type", "state"]);
    const isFinal =
      inProgress != null
        ? !inProgress
        : (isFinalRaw ?? (status ? /final|complete|done/i.test(status) : true));

    const id = firstString(data, ["id", "uuid", "lineId"]) ?? `t${++this.seq}`;
    const at = firstString(data, ["completeDate", "date", "timestamp", "time"]) ?? new Date().toISOString();
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
    const at = this.finals.findIndex((l) => l.id === line.id);
    if (at !== -1) this.finals[at] = line;
    else this.finals.push(line);
    if (this.finals.length > MAX_LINES) this.finals.splice(0, this.finals.length - MAX_LINES);
  }

  // Prime the buffer from the REST snapshot so a display opened mid-service shows
  // prior lines immediately (the SSE stream only carries lines from now on).
  private backfill(host: string, port: number): void {
    const req = http.get(
      { host, port, path: "/api/v1/transcript", headers: this.authHeaders(this.apiKey), timeout: 4000 },
      (res) => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          res.destroy();
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(body);
            const rows = Array.isArray(parsed)
              ? parsed
              : (pick(parsed, "transcripts") ?? pick(parsed, "items") ?? pick(parsed, "data"));
            if (!Array.isArray(rows)) return;
            let added = false;
            for (const row of rows) {
              const line = this.normalizeLine(row);
              if (line?.isFinal) {
                this.addFinal(line);
                added = true;
              }
            }
            if (added) broadcast("prodcom:transcript", this.getBuffer());
          } catch {
            /* snapshot not JSON / unavailable — ignore, stream still works */
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      /* backfill is best-effort */
    });
  }
}

export const prodcomService = new ProdComService();
