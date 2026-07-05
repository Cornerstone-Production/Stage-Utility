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
import { broadcast, channelHasSubscribers } from "./broadcaster.js";

const RECONNECT_MS = 4000;
const MAX_LINES = 100;
// Coalesce interim partials (which arrive many/sec while someone speaks) into at most
// one full-buffer broadcast per this window; finals still push immediately.
const TRANSCRIPT_THROTTLE_MS = 250;

type ProdComConnState = "connected" | "error" | "disconnected";

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

class ProdComService {
  private host: string | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;
  private req: http.ClientRequest | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private seq = 0;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptDirty = false;

  /** Finalised lines (rolling) + the current partial per channel. */
  private finals: TranscriptLineDTO[] = [];
  private partials = new Map<string, TranscriptLineDTO>();

  private onConn: ((state: ProdComConnState, message: string | null) => void) | null = null;
  private reported: ProdComConnState | null = null;

  setConnectionListener(cb: (state: ProdComConnState, message: string | null) => void): void {
    this.onConn = cb;
  }
  private report(state: ProdComConnState, message: string | null): void {
    if (this.reported === state) return;
    this.reported = state;
    this.onConn?.(state, message);
  }

  configure(host: string, port: number, apiKey: string | null): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.apiKey = apiKey?.trim() || null;
    this.reported = null;
    this.restart();
  }

  start(): void {
    if (this.running || !this.host || !this.port) return;
    this.running = true;
    console.log(`[prodcom] connecting ${this.host}:${this.port}`);
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.req?.destroy();
    this.req = null;
  }

  private restart(): void {
    this.stop();
    if (this.host && this.port) this.start();
  }

  /** Current rolling buffer (finals + active partials), oldest → newest. */
  getBuffer(): TranscriptLineDTO[] {
    return [...this.finals, ...this.partials.values()];
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

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.connect();
    }, RECONNECT_MS);
  }

  private connect(): void {
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

        // Parse text/event-stream: accumulate until a blank line ends an event.
        let buf = "";
        res.on("data", (chunk: string) => {
          buf += chunk;
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            this.handleEvent(raw);
          }
        });
        res.on("end", () => {
          this.report("disconnected", null);
          this.scheduleReconnect();
        });
        res.on("error", () => this.scheduleReconnect());
      },
    );
    this.req = req;
    req.on("error", (e) => {
      this.report("error", `Can't reach ${host}:${port} — ${e.message}`);
      this.scheduleReconnect();
    });
  }

  // One SSE event block ("event: x\ndata: {...}"). data may be JSON or plain text.
  private handleEvent(raw: string): void {
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
      firstString(data, ["color", "colour", "channelColor", "channel_color", "hexColor", "hex"]),
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
      this.partials.delete(ch);
      this.addFinal(line);
      this.flushTranscript(); // finals land immediately
    } else {
      this.partials.set(ch, line);
      this.scheduleTranscript(); // interim partials arrive many/sec — coalesce them
    }
  }

  private flushTranscript(): void {
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = null;
    }
    this.transcriptDirty = false;
    // Skip the full-buffer spread + push when no transcription display is watching.
    if (channelHasSubscribers("prodcom:transcript")) broadcast("prodcom:transcript", this.getBuffer());
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
