// smaart-service.ts — Connects to Smaart's API (JSON-over-WebSocket, port 26000)
// and broadcasts live SPL meter values on "spl:metrics" for the dashboards +
// custom layouts.
//
// Lifecycle mirrors the other LAN integrations (propresenter-service.ts): a
// configure/connect/reconnect loop with exponential backoff. One control
// connection negotiates the API version + lists calibrated inputs, then we open
// one SPL stream per input. Readings are throttled before broadcast so an 8 fps
// meter never re-renders every display 8×/sec.

import type { SplMetricsDTO } from "../types/stage.js";
import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { serviceWindow } from "./service-window.js";
import { ModernSmaartAdapter, type SmaartInput, type SplReading } from "./smaart-protocol.js";

type SmaartConnState = "connected" | "error" | "disconnected";

const RECONNECT_BASE_MS = 3000;
/** Trailing throttle for broadcasts — 4 Hz is smooth for a numeric readout. */
const BROADCAST_THROTTLE_MS = 250;
/** Per-stream frame rate requested from Smaart (≤ 8). */
const TARGET_FPS = 4;

const OFFLINE: SplMetricsDTO = { connected: false, apiVersion: null, meters: {} };

function meterId(deviceName: string, channelName: string): string {
  return `${deviceName}::${channelName}`;
}

class SmaartService {
  private host: string | null = null;
  private port: number | null = null;
  private password: string | null = null;

  private running = false;
  private adapter: ModernSmaartAdapter | null = null;
  private streamClosers: (() => void)[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  private last: SplMetricsDTO = OFFLINE;
  private dirty = false;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  private onConn: ((state: SmaartConnState, message: string | null) => void) | null = null;
  private reported: SmaartConnState | null = null;

  setConnectionListener(cb: (state: SmaartConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  /** Latest snapshot — lets a freshly-loaded display hydrate immediately. */
  getLatest(): SplMetricsDTO {
    return this.last;
  }

  private report(state: SmaartConnState, message: string | null): void {
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
    console.log(`[smaart] connecting ${this.host}:${this.port}`);
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearReconnect();
    this.teardownStreams();
    this.adapter?.close();
    this.adapter = null;
    if (this.last.connected) this.emit(OFFLINE, true);
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
    const adapter = new ModernSmaartAdapter(host, port);
    try {
      await adapter.connect({ password });
      const inputs = await adapter.listInputs();
      const app = adapter.serverInfo?.applicationName ?? "Smaart";
      const ver = adapter.serverInfo?.applicationVersion ?? `API v${adapter.apiVersion}`;
      return {
        ok: true,
        message: `Connected to ${app} ${ver} — ${inputs.length} calibrated input(s)`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      adapter.close();
    }
  }

  private async connect(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    const adapter = new ModernSmaartAdapter(this.host, this.port);
    this.adapter = adapter;
    try {
      await adapter.connect({ password: this.password });
      const inputs = await adapter.listInputs();
      if (!this.running) {
        adapter.close();
        return;
      }
      // Seed the snapshot with empty meters so displays show channels immediately.
      const meters: SplMetricsDTO["meters"] = {};
      for (const inp of inputs) {
        meters[meterId(inp.deviceName, inp.channelName)] = {
          deviceName: inp.deviceName,
          channelName: inp.channelName,
          metrics: {},
          ts: null,
        };
      }
      this.last = { connected: true, apiVersion: adapter.apiVersion, meters };
      this.openStreams(adapter, inputs);
      this.reconnectAttempt = 0;
      this.report(
        "connected",
        `Connected to ${adapter.serverInfo?.applicationName ?? "Smaart"} — ${inputs.length} input(s)`,
      );
      this.emit(this.last, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[smaart] connect error:", msg);
      this.report("error", `Can't reach ${this.host}:${this.port} — ${msg}`);
      adapter.close();
      if (this.adapter === adapter) this.adapter = null;
      if (this.last.connected) this.emit(OFFLINE, true);
      this.scheduleReconnect();
    }
  }

  private openStreams(adapter: ModernSmaartAdapter, inputs: SmaartInput[]): void {
    this.teardownStreams();
    for (const inp of inputs) {
      const id = meterId(inp.deviceName, inp.channelName);
      const closer = adapter.openSplStream(
        inp,
        TARGET_FPS,
        (reading: SplReading) => this.onReading(id, reading),
        () => this.onStreamClose(adapter),
      );
      this.streamClosers.push(closer);
    }
  }

  private onReading(id: string, reading: SplReading): void {
    const meter = this.last.meters[id];
    if (meter) {
      meter.metrics = reading.metrics;
      meter.ts = reading.timestamp;
    } else {
      this.last.meters[id] = {
        deviceName: reading.deviceName,
        channelName: reading.channelName,
        metrics: reading.metrics,
        ts: reading.timestamp,
      };
    }
    this.scheduleBroadcast();
  }

  /** A stream dropped — if we're still meant to be running, reconnect the lot. */
  private onStreamClose(adapter: ModernSmaartAdapter): void {
    if (!this.running || this.adapter !== adapter) return;
    console.warn("[smaart] stream closed — reconnecting");
    this.teardownStreams();
    adapter.close();
    if (this.adapter === adapter) this.adapter = null;
    this.report("error", "Smaart stream dropped — reconnecting");
    if (this.last.connected) this.emit(OFFLINE, true);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.clearReconnect();
    const delay = serviceWindow.capDelayMs(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, channelHasSubscribers("spl:metrics"));
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownStreams(): void {
    for (const close of this.streamClosers.splice(0)) {
      try {
        close();
      } catch {
        /* ignore */
      }
    }
  }

  // Trailing throttle: coalesce a burst of readings into one broadcast.
  private scheduleBroadcast(): void {
    this.dirty = true;
    if (this.throttleTimer) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.dirty) this.emit(this.last, false);
    }, BROADCAST_THROTTLE_MS);
  }

  private emit(snapshot: SplMetricsDTO, immediate: boolean): void {
    this.last = snapshot; // always kept fresh — the SPL recorder pulls getLatest()
    this.dirty = false;
    if (immediate && this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    // 4 Hz to nobody is wasted work — skip the push when no display renders SPL
    // meters. Recording is unaffected (it reads this.last, not the broadcast).
    if (channelHasSubscribers("spl:metrics")) broadcast("spl:metrics", snapshot);
  }
}

export const smaartService = new SmaartService();
