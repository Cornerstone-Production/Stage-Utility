// sennheiser-ssc.ts — Shared base for Sennheiser Sound Control (SSC) wireless
// providers that speak JSON-over-UDP on port 45 (EW-G4 / SSCv1 and EW-DX / SSCv2).
//
// SSC models an OSC address tree as nested JSON: the object path mirrors the OSC
// address and a leaf value of `null` means "GET". e.g. the address `/rx1/rf/level`
// is queried by sending `{"rx1":{"rf":{"level":null}}}`; the device replies with the
// same shape carrying the value. Devices push updates for subscribed addresses.
//
// Transport is UDP (NOT TCP) — this was the key correction to the original EW-G4
// provider, which opened a TCP socket and so never talked to real hardware. UDP is
// connectionless, so "connected" here means "we've heard a valid reply recently":
// a watchdog flips the state to error/offline after a silence window.
//
// Subclasses supply the address tree + subscription payloads (via onConnected/onPoll)
// and the frame→DeviceStatus mapping (via handleFrame). Everything transport/lifecycle
// is shared here. Set SENNHEISER_DEBUG=1 to log every raw datagram in/out.

import * as dgram from "node:dgram";

import type { DeviceChannel, DeviceProvider, DeviceStatus } from "../../types/devices.js";
import type { ConfigField, ConnectionState } from "../../types/integrations.js";

export const SSC_DEFAULT_PORT = 45;
const PING_INTERVAL_MS = 5_000; // liveness probe (GET /device/name)
const POLL_INTERVAL_MS = 3_000; // subclass query / subscription-renew cadence
const RESPONSE_TIMEOUT_MS = 8_000; // no valid reply for this long → mark offline
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 120_000;

export const SSC_DEBUG = !!process.env.SENNHEISER_DEBUG;

// Per-channel mutable runtime state (same shape the Shure providers track, so a
// Sennheiser channel maps onto DeviceStatus identically downstream).
export interface SscChannelState {
  channelId: string;
  name: string | null;
  deviceType: "receiver" | "iem" | "charger";
  online: boolean;
  rfBars: number | null;
  rfLevelDbm: number | null;
  battery: number | null;
  charging: boolean | null;
  frequencyLabel: string | null;
  audioLevel: number | null;
  cycles: number | null;
  health: number | null;
  tempC: number | null;
}

export abstract class SennheiserSscBase implements DeviceProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly configSchema: ConfigField[];
  /** Default channel count when cfg.channels is not supplied. */
  protected abstract readonly defaultChannels: number;
  /** Default device type for channels; charger subclasses override per-channel. */
  protected abstract readonly defaultDeviceType: "receiver" | "iem" | "charger";

  protected host: string | null = null;
  protected port = SSC_DEFAULT_PORT;
  protected channelCount = 2;
  protected meterRateMs = POLL_INTERVAL_MS;

  private socket: dgram.Socket | null = null;
  private running = false;
  private connState: ConnectionState = "disconnected";
  private statusCb: ((s: DeviceStatus) => void) | null = null;
  private connCb: ((state: ConnectionState) => void) | null = null;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = RECONNECT_BASE_MS;

  protected channels = new Map<string, SscChannelState>();

  // ── DeviceProvider interface ──────────────────────────────────────────────

  onStatus(cb: (s: DeviceStatus) => void): void {
    this.statusCb = cb;
  }
  onConnectionStateChange(cb: (state: ConnectionState) => void): void {
    this.connCb = cb;
  }
  getConnectionState(): ConnectionState {
    return this.connState;
  }

  async connect(cfg: Record<string, unknown>): Promise<void> {
    this.host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    this.port = numOr(cfg.port, SSC_DEFAULT_PORT);
    this.channelCount = Math.max(1, numOr(cfg.channels, this.defaultChannels));
    const rate = numOr(cfg.meterRateMs, POLL_INTERVAL_MS);
    this.meterRateMs = rate >= 500 ? rate : POLL_INTERVAL_MS;
    this.initChannels();
    this.running = true;
    this.open();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.markAllOffline();
    this.closeSocket();
    this.setState("disconnected");
  }

  async listChannels(): Promise<DeviceChannel[]> {
    return [...this.channels.values()].map((st) => ({
      id: st.channelId,
      label: st.name ?? `Ch ${st.channelId}`,
    }));
  }

  // ── Subclass hooks ────────────────────────────────────────────────────────

  /** Initialise the channel-state map. Override for non-default layouts (e.g. a
   *  charger keyed by bay). Base creates `channelCount` receiver channels 1..N. */
  protected initChannels(): void {
    this.channels.clear();
    for (let n = 1; n <= this.channelCount; n++) {
      this.channels.set(String(n), this.blankChannel(String(n), this.defaultDeviceType));
    }
  }

  /** Sent once when the socket is ready — static queries + initial subscriptions. */
  protected abstract onConnected(): void;

  /** Sent on every poll tick — subscription renewals and/or metering queries. */
  protected abstract onPoll(): void;

  /** Map one decoded SSC frame (nested JSON object) onto channel state, then
   *  call {@link emit} for each channel it touched. */
  protected abstract handleFrame(frame: Record<string, unknown>): void;

  // ── Protected helpers ─────────────────────────────────────────────────────

  protected blankChannel(id: string, deviceType: "receiver" | "iem" | "charger"): SscChannelState {
    return {
      channelId: id,
      name: null,
      deviceType,
      online: false,
      rfBars: null,
      rfLevelDbm: null,
      battery: null,
      charging: null,
      frequencyLabel: null,
      audioLevel: null,
      cycles: null,
      health: null,
      tempC: null,
    };
  }

  /** Serialize an SSC message object and send it as one UDP datagram. */
  protected send(obj: unknown): void {
    if (!this.socket || !this.host) return;
    const line = JSON.stringify(obj);
    if (SSC_DEBUG) console.log(`[sennheiser:${this.id}] → ${line}`);
    this.socket.send(Buffer.from(line, "utf8"), this.port, this.host);
  }

  /** Emit a DeviceStatus for one channel to the pipeline. */
  protected emit(st: SscChannelState): void {
    this.statusCb?.({
      channelId: st.channelId,
      name: st.name,
      deviceType: st.deviceType,
      online: st.online,
      rfBars: st.rfBars,
      rfLevelDbm: st.rfLevelDbm,
      battery: st.battery,
      charging: st.charging,
      frequencyLabel: st.frequencyLabel,
      audioLevel: st.audioLevel,
      cycles: st.cycles,
      health: st.health,
      tempC: st.tempC,
      updatedAt: new Date().toISOString(),
    });
  }

  protected markAllOffline(): void {
    for (const st of this.channels.values()) {
      st.online = false;
      this.emit(st);
    }
  }

  // ── Private networking / lifecycle ──────────────────────────────────────────

  private open(): void {
    if (!this.running || !this.host) {
      if (!this.host) this.setState("error");
      return;
    }
    this.setState("connecting");
    const sock = dgram.createSocket("udp4");
    this.socket = sock;

    sock.on("message", (msg: Buffer) => this.onDatagram(msg.toString("utf8")));
    sock.on("error", (err: Error) => {
      if (SSC_DEBUG) console.log(`[sennheiser:${this.id}] socket error: ${err.message}`);
      this.closeSocket();
      this.markAllOffline();
      if (this.running) {
        this.setState("error");
        this.scheduleReconnect();
      }
    });
    sock.on("listening", () => {
      if (SSC_DEBUG) console.log(`[sennheiser:${this.id}] listening → ${this.host}:${this.port} (UDP)`);
      // UDP has no handshake; kick off queries and let the watchdog decide liveness.
      this.onConnected();
      this.startTimers();
    });

    // Bind an ephemeral local port so replies route back to us.
    try {
      sock.bind();
    } catch (err) {
      if (SSC_DEBUG) console.log(`[sennheiser:${this.id}] bind failed: ${String(err)}`);
      this.setState("error");
      this.scheduleReconnect();
    }
  }

  private onDatagram(text: string): void {
    // A datagram is usually one JSON object; be tolerant of newline-joined frames.
    for (const line of text.split(/[\r\n]+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (SSC_DEBUG) console.log(`[sennheiser:${this.id}] ← ${trimmed}`);
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // not JSON — ignore
      }
      if (!msg || typeof msg !== "object") continue;
      // Any valid frame proves the device is alive → connected + reset watchdog.
      this.reconnectMs = RECONNECT_BASE_MS;
      if (this.connState !== "connected") this.setState("connected");
      this.armWatchdog();
      try {
        this.handleFrame(msg as Record<string, unknown>);
      } catch (err) {
        if (SSC_DEBUG) console.log(`[sennheiser:${this.id}] parse error: ${String(err)}`);
      }
    }
  }

  private startTimers(): void {
    this.clearTimers();
    // Liveness probe: a GET on the device name is harmless and universally answered.
    this.pingTimer = setInterval(() => this.send({ device: { name: null } }), PING_INTERVAL_MS);
    this.pollTimer = setInterval(() => this.onPoll(), this.meterRateMs);
    this.armWatchdog();
    // Prime immediately.
    this.send({ device: { name: null } });
    this.onPoll();
  }

  // Silence for RESPONSE_TIMEOUT_MS ⇒ treat as offline (device unplugged / wrong IP).
  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (!this.running) return;
      this.markAllOffline();
      this.setState("error");
    }, RESPONSE_TIMEOUT_MS);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.initChannels();
      this.open();
    }, delay);
  }

  private setState(s: ConnectionState): void {
    if (s === this.connState) return;
    this.connState = s;
    this.connCb?.(s);
  }

  private clearTimers(): void {
    for (const t of [this.pingTimer, this.pollTimer]) if (t) clearInterval(t);
    for (const t of [this.watchdog, this.reconnectTimer]) if (t) clearTimeout(t);
    this.pingTimer = this.pollTimer = null;
    this.watchdog = this.reconnectTimer = null;
  }

  private closeSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
  }
}

// ── SSC address-tree helpers (shared by subclasses) ───────────────────────────

/** Coerce a config value to a finite number, else `fallback`. */
export function numOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Coerce to a finite number or null (for telemetry values). */
export function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read a nested value by path, tolerating missing/oddly-typed intermediates.
 *  readPath({m:{rx1:{rsqi:80}}}, ["m","rx1","rsqi"]) === 80 */
export function readPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Build (or extend) a nested query object, placing `leaf` at the given path.
 *  buildQuery(["rx1","rf","level"]) === {rx1:{rf:{level:null}}} */
export function buildQuery(path: string[], leaf: unknown = null, into: Record<string, unknown> = {}): Record<string, unknown> {
  let cur = into;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!cur[key] || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = leaf;
  return into;
}

/** Clamp a bar count to the 0–5 scale the UI expects. */
export function clampBars(n: number): number {
  return Math.max(0, Math.min(5, n));
}

/** Format an SSC frequency to `NNN.NNN MHz`. SSC reports kHz (e.g. 524150) or MHz
 *  (e.g. 524.15); auto-detect by magnitude. Returns null for junk. */
export function formatSscFrequency(raw: unknown): string | null {
  const n = numOrNull(raw);
  if (n == null || n <= 0) return null;
  const mhz = n > 10_000 ? n / 1000 : n; // >10000 ⇒ kHz
  return `${mhz.toFixed(3)} MHz`;
}
