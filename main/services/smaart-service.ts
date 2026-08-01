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
import { broadcast } from "./broadcaster.js";
import { StatusIntegration } from "./integration-base.js";
import { ModernSmaartAdapter, type SmaartInput, type SplReading } from "./smaart-protocol.js";
/** Trailing throttle for broadcasts — 4 Hz is smooth for a numeric readout. */
const BROADCAST_THROTTLE_MS = 250;
/** Per-stream frame rate requested from Smaart (≤ 8). */
const TARGET_FPS = 4;

const OFFLINE: SplMetricsDTO = { connected: false, apiVersion: null, meters: {} };

function meterId(deviceName: string, channelName: string): string {
  return `${deviceName}::${channelName}`;
}

class SmaartService extends StatusIntegration<SplMetricsDTO> {
  private host: string | null = null;
  private port: number | null = null;
  private password: string | null = null;

  private adapter: ModernSmaartAdapter | null = null;
  private streamClosers: (() => void)[] = [];

  private dirty = false;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super("smaart", "spl:metrics", OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.host && !!this.port;
  }

  configure(host: string, port: number, password: string | null): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.password = password?.trim() || null;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[smaart] connecting ${this.host}:${this.port}`);
    super.start();
  }

  protected override teardown(): void {
    this.teardownStreams();
    this.adapter?.close();
    this.adapter = null;
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

  protected async connect(): Promise<void> {
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
      this.resetBackoff();
      this.report(
        "connected",
        `Connected to ${adapter.serverInfo?.applicationName ?? "Smaart"} — ${inputs.length} input(s)`,
      );
      this.publish(this.last, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.attempt === 0) console.warn(`[smaart] ${this.host}:${this.port} unreachable (${msg}) — backing off quietly`);
      this.report("error", `Can't reach ${this.host}:${this.port} — ${msg}`);
      adapter.close();
      if (this.adapter === adapter) this.adapter = null;
      this.goOffline();
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
    if (this.attempt === 0) console.warn("[smaart] stream closed — reconnecting");
    this.teardownStreams();
    adapter.close();
    if (this.adapter === adapter) this.adapter = null;
    this.report("error", "Smaart stream dropped — reconnecting");
    this.goOffline();
    this.scheduleReconnect();
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
      if (this.dirty) this.publish(this.last, false);
    }, BROADCAST_THROTTLE_MS);
  }

  /** The base's emit() means "publish now" — which is what goOffline() wants. */
  protected override emit(snapshot: SplMetricsDTO): void {
    this.publish(snapshot, true);
  }

  private publish(snapshot: SplMetricsDTO, immediate: boolean): void {
    this.last = snapshot; // always kept fresh — the SPL recorder pulls getLatest()
    this.dirty = false;
    if (immediate && this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    // 4 Hz to nobody is wasted work — skip the push when no display renders SPL
    // meters. Recording is unaffected (it reads this.last, not the broadcast).
    if (this.hasSubscribers) broadcast(this.channel, snapshot);
  }
}

export const smaartService = new SmaartService();
