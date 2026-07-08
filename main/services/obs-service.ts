// obs-service.ts — Connects to OBS Studio (obs-websocket v5, default port 4455)
// and broadcasts live output state on "obs:status" for the custom-layout
// "OBS status" object.
//
// Lifecycle mirrors the other LAN integrations (smaart-service.ts): a
// configure/connect/reconnect loop with exponential backoff. One WebSocket does
// the handshake, seeds state with GetRecordStatus/GetStreamStatus/
// GetVirtualCamStatus, then stays live on events. While recording, a 1 Hz poll
// refreshes the record timecode.

import type { ObsStatusDTO } from "../types/stage.js";
import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { serviceWindow } from "./service-window.js";
import { ObsWebSocketAdapter, type ObsEvent } from "./obs-protocol.js";

type ObsConnState = "connected" | "error" | "disconnected";

const RECONNECT_BASE_MS = 3000;
const TIMECODE_POLL_MS = 1000;

const OFFLINE: ObsStatusDTO = {
  connected: false,
  recording: false,
  recordPaused: false,
  streaming: false,
  virtualCam: false,
  recordTimecode: null,
};

/** Normalize OBS's "HH:MM:SS.mmm" timecode to "HH:MM:SS" (drop millis). */
function trimTimecode(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const dot = v.indexOf(".");
  return dot === -1 ? v : v.slice(0, dot);
}

/**
 * Fold one OBS event into the status snapshot. Pure + exported so the event→DTO
 * mapping can be unit-tested without a live OBS. RecordStateChanged keeps
 * `recording` true while paused (OBS still has a recording in progress).
 */
export function reduceObsEvent(prev: ObsStatusDTO, evt: ObsEvent): ObsStatusDTO {
  const d = evt.eventData;
  switch (evt.eventType) {
    case "RecordStateChanged": {
      const active = d.outputActive === true;
      const state = typeof d.outputState === "string" ? d.outputState : "";
      return {
        ...prev,
        recording: active,
        recordPaused: state.endsWith("PAUSED"),
        recordTimecode: active ? prev.recordTimecode : null,
      };
    }
    case "StreamStateChanged":
      return { ...prev, streaming: d.outputActive === true };
    case "VirtualcamStateChanged":
      return { ...prev, virtualCam: d.outputActive === true };
    default:
      return prev;
  }
}

class ObsService {
  private host: string | null = null;
  private port: number | null = null;
  private password: string | null = null;

  private running = false;
  private adapter: ObsWebSocketAdapter | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private last: ObsStatusDTO = OFFLINE;

  private onConn: ((state: ObsConnState, message: string | null) => void) | null = null;
  private reported: ObsConnState | null = null;

  setConnectionListener(cb: (state: ObsConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  /** Latest snapshot — lets a freshly-loaded display hydrate immediately. */
  getLatest(): ObsStatusDTO {
    return this.last;
  }

  private report(state: ObsConnState, message: string | null): void {
    if (this.reported === state) return;
    this.reported = state;
    this.onConn?.(state, message);
  }

  configure(host: string, port: number, password: string | null): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.password = password?.trim() || null;
    this.reported = null;
    this.restart();
  }

  start(): void {
    if (this.running || !this.host || !this.port) return;
    this.running = true;
    this.reconnectAttempt = 0;
    console.log(`[obs] connecting ${this.host}:${this.port}`);
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearReconnect();
    this.clearPoll();
    this.adapter?.close();
    this.adapter = null;
    if (this.last.connected) this.emit(OFFLINE);
  }

  private restart(): void {
    this.stop();
    if (this.host && this.port) this.start();
  }

  /** One-shot reachability check for the Integrations "Test connection" button. */
  async test(
    host: string,
    port: number,
    password: string | null,
  ): Promise<{ ok: boolean; message?: string }> {
    const adapter = new ObsWebSocketAdapter(host, port);
    try {
      await adapter.connect({ password });
      const ver = await adapter.request("GetVersion");
      const obsVer = typeof ver.obsVersion === "string" ? ver.obsVersion : "?";
      const wsVer = typeof ver.obsWebSocketVersion === "string" ? ver.obsWebSocketVersion : "?";
      return { ok: true, message: `Connected to OBS ${obsVer} (obs-websocket ${wsVer})` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      adapter.close();
    }
  }

  private async connect(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    const adapter = new ObsWebSocketAdapter(this.host, this.port);
    this.adapter = adapter;
    adapter.onEvent((e) => this.onEvent(adapter, e));
    adapter.onClose(() => this.onClose(adapter));
    try {
      await adapter.connect({ password: this.password });
      if (!this.running) {
        adapter.close();
        return;
      }
      // Seed state from OBS's current outputs (best-effort per request).
      const snap: ObsStatusDTO = { ...OFFLINE, connected: true };
      try {
        const rec = await adapter.request("GetRecordStatus");
        snap.recording = rec.outputActive === true;
        snap.recordPaused = rec.outputPaused === true;
        snap.recordTimecode = snap.recording ? trimTimecode(rec.outputTimecode) : null;
      } catch {
        /* older OBS or denied — leave defaults */
      }
      try {
        const stream = await adapter.request("GetStreamStatus");
        snap.streaming = stream.outputActive === true;
      } catch {
        /* ignore */
      }
      try {
        const vcam = await adapter.request("GetVirtualCamStatus");
        snap.virtualCam = vcam.outputActive === true;
      } catch {
        /* ignore */
      }
      if (this.adapter !== adapter) return; // superseded while awaiting
      this.reconnectAttempt = 0;
      this.report("connected", `Connected to OBS at ${this.host}:${this.port}`);
      this.emit(snap);
      this.startPoll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.reconnectAttempt === 0) console.warn(`[obs] ${this.host}:${this.port} unreachable (${msg}) — backing off quietly`);
      this.report("error", `Can't reach ${this.host}:${this.port} — ${msg}`);
      adapter.close();
      if (this.adapter === adapter) this.adapter = null;
      if (this.last.connected) this.emit(OFFLINE);
      this.scheduleReconnect();
    }
  }

  private onEvent(adapter: ObsWebSocketAdapter, evt: ObsEvent): void {
    if (this.adapter !== adapter) return;
    const next = reduceObsEvent(this.last, evt);
    if (next !== this.last) this.emit(next);
  }

  private onClose(adapter: ObsWebSocketAdapter): void {
    if (!this.running || this.adapter !== adapter) return;
    if (this.reconnectAttempt === 0) console.warn("[obs] connection closed — reconnecting");
    this.clearPoll();
    if (this.adapter === adapter) this.adapter = null;
    this.report("error", "OBS connection dropped — reconnecting");
    if (this.last.connected) this.emit(OFFLINE);
    this.scheduleReconnect();
  }

  // Refresh the record timecode once a second while recording (the only value
  // OBS doesn't push on its own). No-op otherwise.
  private startPoll(): void {
    this.clearPoll();
    this.pollTimer = setInterval(() => void this.pollTimecode(), TIMECODE_POLL_MS);
  }

  private async pollTimecode(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter || !this.last.connected || !this.last.recording) return;
    try {
      const rec = await adapter.request("GetRecordStatus");
      if (this.adapter !== adapter) return;
      const tc = trimTimecode(rec.outputTimecode);
      if (tc !== this.last.recordTimecode) this.emit({ ...this.last, recordTimecode: tc });
    } catch {
      /* transient — the next tick retries */
    }
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.clearReconnect();
    const delay = serviceWindow.capDelayMs(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, channelHasSubscribers("obs:status"));
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit(snapshot: ObsStatusDTO): void {
    this.last = snapshot;
    broadcast("obs:status", snapshot);
  }
}

export const obsService = new ObsService();
