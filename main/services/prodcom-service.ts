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
import { broadcast } from "./broadcaster.js";

const RECONNECT_MS = 4000;
const MAX_LINES = 100;

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

class ProdComService {
  private host: string | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;
  private req: http.ClientRequest | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private seq = 0;

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
      return { id: `t${++this.seq}`, channel: null, channelName: null, text: data, isFinal: true, at: new Date().toISOString() };
    }
    const text = firstString(data, ["text", "transcript", "content", "line", "value"]);
    if (text == null) return null;
    const channel = firstString(data, ["channelId", "channel", "channel_id", "channelIndex"]);
    const channelName = firstString(data, ["channelName", "channel_name", "name", "label"]);

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
    return { id, channel, channelName, text, isFinal, at };
  }

  private ingest(line: TranscriptLineDTO): void {
    const ch = line.channel ?? "_";
    if (line.isFinal) {
      this.partials.delete(ch);
      this.finals.push(line);
      if (this.finals.length > MAX_LINES) this.finals.splice(0, this.finals.length - MAX_LINES);
    } else {
      this.partials.set(ch, line);
    }
    broadcast("prodcom:transcript", this.getBuffer());
  }
}

export const prodcomService = new ProdComService();
