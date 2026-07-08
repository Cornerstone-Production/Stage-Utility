// shure-base.ts â Abstract base class for Shure ASCII-over-TCP wireless providers.
// Protocol: messages are framed as `< PAYLOAD >` over a persistent TCP connection.
// Framing: accumulate in a string buffer; split on `>`; for each segment strip
// leading `<` / whitespace and trim; tokenise by spaces. Ignore partial/empty.

import * as net from "net";
import type { DeviceChannel, DeviceProvider, DeviceStatus } from "../../types/devices.js";
import type { ConfigField, ConnectionState } from "../../types/integrations.js";
import { serviceWindow } from "../../services/service-window.js";

// Per-channel mutable runtime state.
export interface ChannelState {
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
  /** Charger-bay telemetry (null for mics & IEMs). */
  cycles: number | null;
  health: number | null;
  tempC: number | null;
}

export interface ShureConfig {
  host: string;
  port: number;
  channels: number;
  /** Metering/polling interval in ms (0 = off). */
  meterRateMs: number;
}

// Reconnect back-off: start at 3s and double; the service-window scheduler applies the real ceiling
// (≤2 min in/near a service, stretched toward the idle ceiling otherwise).
const RECONNECT_BASE_MS = 3_000;
// Connect-phase inactivity timeout (ms) â fail fast on a wrong/unreachable IP.
const CONNECT_TIMEOUT_MS = 10_000;
// Heartbeat interval in ms. 60s (was 30s) â TCP keep-alive is already enabled at
// the socket level (setKeepAlive), so this app-level probe only needs to be a
// slow backstop; halving it trims idle command chatter to each receiver.
const HEARTBEAT_INTERVAL_MS = 60_000;

export abstract class ShureBaseProvider implements DeviceProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly configSchema: ConfigField[];
  /** Default channel count if cfg.channels is not supplied. */
  protected abstract readonly defaultChannels: number;
  /** Default device type for channels. Override per-subclass. */
  protected abstract readonly defaultDeviceType: "receiver" | "iem" | "charger";

  private socket: net.Socket | null = null;
  private receiveBuffer = "";
  private connectionState: ConnectionState = "disconnected";
  private statusCallback: ((s: DeviceStatus) => void) | null = null;
  private stateChangeCallback: ((state: ConnectionState) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive failed connect attempts, for exponential reconnect back-off.
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  private cfg: ShureConfig = { host: "", port: 2202, channels: 1, meterRateMs: 1000 };

  /** Metering interval (ms) for this connection â set from config on connect. */
  protected get meterRateMs(): number {
    return this.cfg.meterRateMs;
  }

  // Per-channel state, keyed by channel number (1-based).
  protected channelStates = new Map<number, ChannelState>();

  // ââ DeviceProvider interface ââââââââââââââââââââââââââââââââââââââââââââââ

  onStatus(cb: (s: DeviceStatus) => void): void {
    this.statusCallback = cb;
  }

  onConnectionStateChange(cb: (state: ConnectionState) => void): void {
    this.stateChangeCallback = cb;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  async connect(cfg: Record<string, unknown>): Promise<void> {
    this.enabled = true;
    this.cfg = this.parseCfg(cfg);
    this.initChannelStates(this.cfg.channels);
    await this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.enabled = false;
    this.reconnectAttempts = 0;
    this.clearTimers();
    this.destroySocket();
    this.setConnectionState("disconnected");
    this.markAllChannelsOffline();
  }

  async listChannels(): Promise<DeviceChannel[]> {
    const result: DeviceChannel[] = [];
    for (let n = 1; n <= this.cfg.channels; n++) {
      const state = this.channelStates.get(n);
      result.push({
        id: String(n),
        label: state?.name ?? `Ch ${n}`,
      });
    }
    return result;
  }

  // ââ Subclass hooks ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

  /** Called once the socket is connected. Subclasses send init/metering commands here. */
  protected abstract onConnected(): void;

  /** Handle a REP/REPORT message for a channel or device.
   *  @param channel  Channel number (1-based), or 0 for device-level.
   *  @param token    The specific field name (e.g. CHAN_NAME, BATT_BARS).
   *  @param rest     Remaining tokens after the field name.
   */
  protected abstract handleReport(channel: number, token: string, rest: string[]): void;

  /** Handle a SAMPLE message for a channel.
   *  @param channel  Channel number (1-based).
   *  @param tokens   Full token array (including SAMPLE and channel tokens).
   */
  protected abstract handleSample(channel: number, tokens: string[]): void;

  // ââ Protected helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââ

  /** Send a command over the TCP socket. cmd must NOT include the `< >` framing. */
  protected send(cmd: string): void {
    if (!this.socket || this.connectionState !== "connected") return;
    const raw = `< ${cmd} >\n`;
    try {
      this.socket.write(raw);
    } catch (err) {
      console.error(`[shure:${this.id}] send error:`, err);
    }
  }

  /** When true, REP/SAMPLE frames for a channel beyond the configured count
   *  auto-create that channel (capped at maxDynamicChannels). Chargers enable
   *  this: `GET 0 ALL` dumps every populated bay, so the bay count self-discovers
   *  regardless of the connection's "Number of Bays" setting. */
  protected allowDynamicChannels = false;
  protected readonly maxDynamicChannels = 64;

  private buildDefaultChannelState(n: number): ChannelState {
    return {
      channelId: String(n),
      name: null,
      deviceType: this.defaultDeviceType,
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

  /** Initialise (or reset) channel states to their offline defaults. */
  protected initChannelStates(count: number): void {
    this.channelStates.clear();
    for (let n = 1; n <= count; n++) {
      this.channelStates.set(n, this.buildDefaultChannelState(n));
    }
  }

  /** Return true if channel `ch` exists, creating it on demand when dynamic
   *  channels are enabled and `ch` is within the sane cap. */
  protected ensureChannel(ch: number): boolean {
    if (this.channelStates.has(ch)) return true;
    if (!this.allowDynamicChannels || ch < 1 || ch > this.maxDynamicChannels) return false;
    this.channelStates.set(ch, this.buildDefaultChannelState(ch));
    return true;
  }

  /** Emit a DeviceStatus for the given channel. */
  protected emitStatus(channelNumber: number): void {
    const state = this.channelStates.get(channelNumber);
    if (!state || !this.statusCallback) return;
    const status: DeviceStatus = {
      channelId: state.channelId,
      name: state.name,
      deviceType: state.deviceType,
      online: state.online,
      rfBars: state.rfBars,
      rfLevelDbm: state.rfLevelDbm,
      battery: state.battery,
      charging: state.charging,
      frequencyLabel: state.frequencyLabel,
      audioLevel: state.audioLevel,
      cycles: state.cycles,
      health: state.health,
      tempC: state.tempC,
      updatedAt: new Date().toISOString(),
    };
    this.statusCallback(status);
  }

  /** Emit offline status for all channels. */
  protected markAllChannelsOffline(): void {
    for (const [n, state] of this.channelStates) {
      state.online = false;
      this.emitStatus(n);
    }
  }

  // ââ Private networking ââââââââââââââââââââââââââââââââââââââââââââââââââââ

  private parseCfg(raw: Record<string, unknown>): ShureConfig {
    const host = typeof raw.host === "string" ? raw.host.trim() : "";
    const port =
      typeof raw.port === "number" && raw.port > 0 ? Math.floor(raw.port) : 2202;
    const channels =
      typeof raw.channels === "number" && raw.channels > 0
        ? Math.floor(raw.channels)
        : this.defaultChannels;
    const meterRateMs =
      typeof raw.meterRateMs === "number" && raw.meterRateMs >= 0
        ? Math.floor(raw.meterRateMs)
        : 1000;
    return { host, port, channels, meterRateMs };
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateChangeCallback?.(state);
  }

  private async openSocket(): Promise<void> {
    if (!this.cfg.host) {
      console.error(`[shure:${this.id}] no host configured`);
      this.setConnectionState("error");
      return;
    }

    this.setConnectionState("connecting");
    // Log the connect attempt only at the start of an outage (attempts === 0) so a
    // device off all week doesn't spam the log every retry cycle.
    if (this.reconnectAttempts === 0) console.log(`[shure:${this.id}] connecting to ${this.cfg.host}:${this.cfg.port}`);

    const socket = new net.Socket();
    this.socket = socket;
    this.receiveBuffer = "";

    socket.setEncoding("utf8");
    socket.setKeepAlive(true, 10_000);
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      console.log(`[shure:${this.id}] connected to ${this.cfg.host}:${this.cfg.port}`);
      socket.setTimeout(0); // disable connect timeout after connected
      this.reconnectAttempts = 0; // reset back-off on a successful connect
      this.setConnectionState("connected");
      this.startHeartbeat();
      this.onConnected();
    });

    socket.on("data", (chunk: string) => {
      this.handleData(chunk);
    });

    socket.on("timeout", () => {
      if (this.reconnectAttempts === 0) console.warn(`[shure:${this.id}] socket timeout`);
      socket.destroy();
    });

    socket.on("error", (err) => {
      if (this.reconnectAttempts === 0) console.warn(`[shure:${this.id}] socket error: ${err.message}`);
      this.setConnectionState("error");
      // Tear down so 'close' fires and we reconnect with back-off, rather than
      // leaving a half-open socket lingering.
      socket.destroy();
    });

    socket.on("close", () => {
      if (this.reconnectAttempts === 0) console.log(`[shure:${this.id}] socket closed`);
      this.stopHeartbeat();
      this.markAllChannelsOffline();
      if (this.connectionState !== "disconnected") {
        this.setConnectionState("disconnected");
      }
      if (this.enabled) {
        this.scheduleReconnect();
      }
    });

    socket.connect(this.cfg.port, this.cfg.host);
  }

  private handleData(chunk: string): void {
    this.receiveBuffer += chunk;

    // Messages are delimited by `>`. Split on it; last segment is a partial frame.
    const segments = this.receiveBuffer.split(">");
    // Keep the final incomplete segment in the buffer.
    this.receiveBuffer = segments.pop() ?? "";

    for (const segment of segments) {
      // Strip leading `<` and any surrounding whitespace.
      const cleaned = segment.replace(/^[\s<]+/, "").trim();
      if (!cleaned) continue;
      // Diagnostic: with SHURE_DEBUG set, log every raw frame exactly as the
      // device sent it. This is the ground truth for aligning the parser to a
      // specific transmitter (e.g. an Axient handheld) when stats don't appear.
      // Enable with `SHURE_DEBUG=1` in the service environment.
      if (process.env.SHURE_DEBUG) {
        console.log(`[shure:${this.id}] RAW < ${cleaned} >`);
      }
      this.parseMessage(cleaned);
    }
  }

  private parseMessage(raw: string): void {
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;

    const type = tokens[0].toUpperCase();

    if (type === "SAMPLE") {
      // Format: SAMPLE {ch} ...
      const ch = parseInt(tokens[1] ?? "", 10);
      if (Number.isNaN(ch) || ch < 1) {
        console.debug(`[shure:${this.id}] SAMPLE â unrecognised channel token: ${tokens[1]}`);
        return;
      }
      if (!this.ensureChannel(ch)) {
        console.debug(`[shure:${this.id}] SAMPLE ch ${ch} outside configured range`);
        return;
      }
      this.handleSample(ch, tokens);
      return;
    }

    if (type === "REP" || type === "REPORT") {
      // Format: REP {ch} {FIELD} {value...}  OR  REP {FIELD} {value...} (device-level)
      if (tokens.length < 3) {
        console.debug(`[shure:${this.id}] short REP message: ${raw}`);
        return;
      }
      const secondToken = tokens[1];
      const chNum = parseInt(secondToken, 10);
      if (!Number.isNaN(chNum)) {
        // Channel-level: REP {ch} {FIELD} {value...}
        if (!this.ensureChannel(chNum)) {
          console.debug(`[shure:${this.id}] REP ch ${chNum} outside configured range`);
          return;
        }
        const field = tokens[2].toUpperCase();
        const rest = tokens.slice(3);
        this.handleReport(chNum, field, rest);
      } else {
        // Device-level: REP {FIELD} {value...}
        const field = tokens[1].toUpperCase();
        const rest = tokens.slice(2);
        this.handleReport(0, field, rest);
      }
      return;
    }

    console.debug(`[shure:${this.id}] unrecognised message type: ${type}`);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = serviceWindow.capDelayMs(RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 20));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled) {
        this.initChannelStates(this.cfg.channels);
        void this.openSocket();
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send("GET 1 METER_RATE");
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private destroySocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.receiveBuffer = "";
  }
}

// ââ Utility helpers (exported for subclasses) âââââââââââââââââââââââââââââ

/** Parse an integer; returns NaN on failure. */
export function safeInt(s: string | undefined): number {
  if (s === undefined) return NaN;
  const n = parseInt(s, 10);
  return n;
}

/** Clamp a number to [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Normalise a dB value within [minDb, maxDb] to a 0..1 float.
 * Values below minDb â 0; values at or above maxDb â 1.
 */
export function normalisedDb(db: number, minDb: number, maxDb: number): number {
  if (maxDb <= minDb) return 0;
  return clamp((db - minDb) / (maxDb - minDb), 0, 1);
}

/** Convert RF level in dBm to a 0â5 bar count. */
export function rfBarsFromDbm(dbm: number): number {
  if (dbm >= -25) return 5;
  if (dbm >= -70) return 4;
  if (dbm >= -77) return 3;
  if (dbm >= -83) return 2;
  if (dbm >= -90) return 1;
  return 0;
}

/** Strip Shure name braces: `{Name}` â `Name`. */
export function stripBraces(s: string): string {
  return s.replace(/^\{/, "").replace(/\}$/, "").trim();
}

/** Format a Shure frequency value (kHz, e.g. "524350" or AD4Q's 7-digit
 *  "0543125") to `NNN.NNN MHz`. Parses as an integer in kHz so it's robust to
 *  leading zeros and field width differing across models. */
export function formatFrequency(raw: string): string | null {
  const khz = parseInt(raw, 10);
  if (Number.isNaN(khz) || khz <= 0) return null;
  return `${(khz / 1000).toFixed(3)} MHz`;
}
