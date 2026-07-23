// reaper-service.ts — Connects to REAPER's built-in Web Interface (Preferences →
// Control/OSC/web → "Web browser interface") and broadcasts live transport state
// on "reaper:status" for the custom-layout "REAPER status" object.
//
// REAPER has no external scripting socket (ReaScript is in-process only), so the
// integration polls the web interface's `GET /_/TRANSPORT` endpoint over HTTP.
// The response is one tab-separated line:
//   TRANSPORT \t playstate \t position_seconds \t isRepeatOn \t position_string \t position_beats
// playstate is a bitmask (bit0 playing, bit1 paused, bit2 recording), so REAPER
// reports 0=stopped, 1=playing, 2=paused, 5=recording, 6=record-paused.
//
// Lifecycle mirrors the other LAN integrations (obs-service.ts): a single timer
// polls while running, steps to a slower cadence when nobody's watching the
// channel, and backs off exponentially while REAPER is unreachable.

import type { ReaperStatusDTO } from "../types/stage.js";
import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { serviceWindow } from "./service-window.js";

type ReaperConnState = "connected" | "error" | "disconnected";

const POLL_MS = 1000; // active cadence (someone is watching the channel)
const IDLE_POLL_MS = 5000; // no subscribers — keep the connection badge warm, cheaply
const RECONNECT_BASE_MS = 3000;
const REQUEST_TIMEOUT_MS = 4000;

const OFFLINE: ReaperStatusDTO = {
  connected: false,
  recording: false,
  recordPaused: false,
  playing: false,
  positionSeconds: null,
  positionString: null,
};

/**
 * Fold one `/_/TRANSPORT` response body into a status snapshot. Pure + exported
 * so the parse can be unit-tested without a live REAPER. `connected` is true for
 * any well-formed TRANSPORT line (the HTTP request reaching REAPER is the link).
 */
export function parseTransport(body: string): ReaperStatusDTO {
  const line = body.split("\n").find((l) => l.startsWith("TRANSPORT")) ?? "";
  const f = line.split("\t");
  if (f[0] !== "TRANSPORT" || f.length < 2) return { ...OFFLINE, connected: true };
  const playstate = Number(f[1]);
  const recording = (playstate & 4) === 4;
  const secs = f.length > 2 && f[2] !== "" ? Number(f[2]) : NaN;
  return {
    connected: true,
    recording,
    recordPaused: recording && (playstate & 2) === 2, // playstate 6
    playing: (playstate & 1) === 1 && !recording,
    positionSeconds: Number.isFinite(secs) ? secs : null,
    positionString: f.length > 4 && f[4] ? f[4] : null,
  };
}

class ReaperService {
  private host: string | null = null;
  private port: number | null = null;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  private last: ReaperStatusDTO = OFFLINE;

  private onConn: ((state: ReaperConnState, message: string | null) => void) | null = null;
  private reported: ReaperConnState | null = null;

  setConnectionListener(cb: (state: ReaperConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  /** Latest snapshot — lets a freshly-loaded display hydrate immediately. */
  getLatest(): ReaperStatusDTO {
    return this.last;
  }

  private report(state: ReaperConnState, message: string | null): void {
    if (this.reported === state) return;
    this.reported = state;
    this.onConn?.(state, message);
  }

  configure(host: string, port: number): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.reported = null;
    this.restart();
  }

  start(): void {
    if (this.running || !this.host || !this.port) return;
    this.running = true;
    this.reconnectAttempt = 0;
    console.log(`[reaper] polling ${this.host}:${this.port}`);
    void this.poll();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    if (this.last.connected) this.emit(OFFLINE);
  }

  private restart(): void {
    this.stop();
    if (this.host && this.port) this.start();
  }

  /** One-shot reachability check for the Integrations "Test connection" button. */
  async test(host: string, port: number): Promise<{ ok: boolean; message?: string }> {
    try {
      const body = await this.fetchTransport(host, port);
      if (!body.startsWith("TRANSPORT")) {
        return { ok: false, message: "Reached the server, but it didn't return TRANSPORT data — is REAPER's web interface enabled?" };
      }
      return { ok: true, message: `Connected to REAPER at ${host}:${port}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchTransport(host: string, port: number): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`http://${host}:${port}/_/TRANSPORT`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`REAPER returned HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    try {
      const body = await this.fetchTransport(this.host, this.port);
      if (!this.running) return;
      if (!this.last.connected) {
        this.reconnectAttempt = 0;
        this.report("connected", `Connected to REAPER at ${this.host}:${this.port}`);
      }
      this.emitIfChanged(parseTransport(body));
      // Poll fast while a display is watching; idle slowly otherwise.
      this.schedule(channelHasSubscribers("reaper:status") ? POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.reconnectAttempt === 0) console.warn(`[reaper] ${this.host}:${this.port} unreachable (${msg}) — backing off quietly`);
      this.report("error", `Can't reach ${this.host}:${this.port} — ${msg}`);
      if (this.last.connected) this.emit(OFFLINE);
      this.scheduleReconnect();
    }
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.clearTimer();
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = serviceWindow.capDelayMs(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, channelHasSubscribers("reaper:status"));
    this.reconnectAttempt++;
    this.schedule(delay);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Broadcast on any meaningful state change; while recording, also tick each
  // poll so a timecode display advances. Otherwise keep `last` current silently
  // (fresh for hydration) without spending an SSE frame.
  private emitIfChanged(next: ReaperStatusDTO): void {
    const p = this.last;
    const stateChanged =
      p.connected !== next.connected ||
      p.recording !== next.recording ||
      p.recordPaused !== next.recordPaused ||
      p.playing !== next.playing;
    const tick = next.recording && p.positionString !== next.positionString;
    if (stateChanged || tick) this.emit(next);
    else this.last = next;
  }

  private emit(snapshot: ReaperStatusDTO): void {
    this.last = snapshot;
    broadcast("reaper:status", snapshot);
  }
}

export const reaperService = new ReaperService();
