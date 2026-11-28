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

import { clamp } from "../../services/clamp.js";
import { scrub } from "../../services/scrub.js";
import * as dgram from "node:dgram";

import type { DeviceChannel, DeviceProvider } from "../../types/devices.js";
import { DeviceProviderBase, blankChannel, type ChannelState } from "./device-provider-base.js";

export const SSC_DEFAULT_PORT = 45;
const PING_INTERVAL_MS = 5_000; // liveness probe (GET /device/name)
const POLL_INTERVAL_MS = 3_000; // subclass query / subscription-renew cadence
const RESPONSE_TIMEOUT_MS = 8_000; // no valid reply for this long → mark offline
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 3_600_000; // internal ceiling; the service-window scheduler applies the real cap

export const SSC_DEBUG = !!process.env.SENNHEISER_DEBUG;

// Per-channel mutable runtime state (same shape the Shure providers track, so a
// Sennheiser channel maps onto DeviceStatus identically downstream).
export abstract class SennheiserSscBase extends DeviceProviderBase implements DeviceProvider {
  abstract readonly id: string;
  abstract readonly label: string;
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

  private reconnectMs = RECONNECT_BASE_MS;

  protected channels = new Map<string, ChannelState>();

  protected logTag(): string {
    return `[sennheiser:${this.id}]`;
  }

  /** The receiver as a log line names it. */
  private where(): string {
    return `${scrub(this.host ?? "?")}:${this.port}`;
  }

  async connect(cfg: Record<string, unknown>): Promise<void> {
    this.host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    this.port = numOr(cfg.port, SSC_DEFAULT_PORT);
    this.channelCount = Math.max(1, numOr(cfg.channels, this.defaultChannels));
    const rate = numOr(cfg.meterRateMs, POLL_INTERVAL_MS);
    this.meterRateMs = rate >= 500 ? rate : POLL_INTERVAL_MS;
    this.initChannels();
    this.forgetFailures();
    this.running = true;
    this.open();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.stopAllTimers();
    this.markAllOffline();
    this.closeSocket();
    this.setState("disconnected");
  }

  async listChannels(): Promise<DeviceChannel[]> {
    return [...this.channels.values()].map((st) => ({
      id: st.channelId,
      label: st.name ?? `Ch ${st.channelId}`,
      deviceType: st.deviceType,
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

  protected blankChannel(id: string, deviceType: ChannelState["deviceType"]): ChannelState {
    return blankChannel(id, { deviceType });
  }

  /** Serialize an SSC message object and send it as one UDP datagram. */
  protected send(obj: unknown): void {
    if (!this.socket || !this.host) return;
    const line = JSON.stringify(obj);
    if (SSC_DEBUG) console.log(`[sennheiser:${this.id}] → ${line}`);
    this.socket.send(Buffer.from(line, "utf8"), this.port, this.host);
  }

  /** Emit a DeviceStatus for one channel to the pipeline. */
  protected emit(st: ChannelState): void {
    this.emitStatus(st);
  }

  protected markAllOffline(): void {
    this.offlineAll(this.channels.values());
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
    sock.on("error", (err: NodeJS.ErrnoException) => {
      this.reportFailure(`socket ${err.code ?? err.message}`, `${this.where()} socket error: ${scrub(err.message)}`);
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
      this.reportFailure("bind", `could not open a UDP socket for ${this.where()}: ${scrub(String(err))}`);
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
      this.setState("connected");
      this.reportWorking();
      this.armSilenceWatchdog();
      try {
        this.handleFrame(msg as Record<string, unknown>);
        this.reportWorking("frame");
      } catch (err) {
        // Not a link failure — the receiver answered — so on its own key, where
        // it can neither end an outage nor be hidden by one.
        this.reportFailure("parse", `${this.where()} sent a frame this driver could not read: ${scrub(String(err))}`, "frame");
      }
    }
  }

  private startTimers(): void {
    this.stopLinkTimers();
    // Liveness probe: a GET on the device name is harmless and universally answered.
    this.every("ping", PING_INTERVAL_MS, () => this.send({ device: { name: null } }));
    this.every("poll", this.meterRateMs, () => this.onPoll());
    this.armSilenceWatchdog();
    // Prime immediately.
    this.send({ device: { name: null } });
    this.onPoll();
  }

  // Silence for RESPONSE_TIMEOUT_MS ⇒ treat as offline (device unplugged / wrong IP).
  private armSilenceWatchdog(): void {
    this.armWatchdog(RESPONSE_TIMEOUT_MS, () => {
      if (!this.running) return;
      this.reportFailure(
        "silent",
        `${this.where()} has not answered for ${RESPONSE_TIMEOUT_MS / 1000}s; marking its channels offline. ` +
          "Check the address, and that the receiver's network control is on.",
      );
      this.markAllOffline();
      this.setState("error");
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectPending) return;
    const raw = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.queueReconnect(raw, () => {
      this.initChannels();
      this.open();
    });
  }

  private closeSocket(): void {
    if (this.socket) {
      // BY NAME — these three are the ones open() attaches, and 'error' is the
      // one that matters: it reconnects, and this method is called from inside
      // that very handler, so leaving it attached is a re-entry waiting to
      // happen. A bare removeAllListeners() would also take Node's own; a fresh
      // dgram.Socket happens to ship with none today, which makes the blanket
      // form harmless here and nowhere else — the same line on the net.Socket in
      // shure-base.ts strips the listener that closes the socket on FIN.
      for (const event of ["message", "error", "listening"] as const) {
        this.socket.removeAllListeners(event);
      }
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
  return clamp(n, 0, 5);
}

/** Format an SSC frequency to `NNN.NNN MHz`. SSC reports kHz (e.g. 524150) or MHz
 *  (e.g. 524.15); auto-detect by magnitude. Returns null for junk. */
export function formatSscFrequency(raw: unknown): string | null {
  const n = numOrNull(raw);
  if (n == null || n <= 0) return null;
  const mhz = n > 10_000 ? n / 1000 : n; // >10000 ⇒ kHz
  return `${mhz.toFixed(3)} MHz`;
}
