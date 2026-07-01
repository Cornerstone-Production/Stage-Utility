// SennheiserEwG4 — Sennheiser ew G4 (and EM/RF) wireless via the Sennheiser Sound
// Control (SSC) protocol: JSON over TCP (default port 45), the same protocol the
// Sennheiser Control Cockpit uses. Implements the shared DeviceProvider contract
// so it slots into the wireless pipeline exactly like the Shure drivers.
//
// ⚠️ HARDWARE-UNVERIFIED. Built against the SSC JSON model without a device on
// hand (the maintainer confirmed they can't test here). The transport + lifecycle
// are solid; the field MAPPING is best-effort and defensive — a per-channel SSC
// tree like { "rx1": { "name": "...", "rf": { "level": .. }, "bat": .. } } is
// parsed tolerantly (unknown shapes degrade to null, never crash). Run with
// SENNHEISER_DEBUG=1 to log every raw frame so the real schema can be confirmed
// on-site and this mapping tuned. Isolated: nothing else depends on it.

import * as net from "node:net";

import type { DeviceChannel, DeviceProvider, DeviceStatus } from "../../types/devices.js";
import type { ConfigField, ConnectionState } from "../../types/integrations.js";

const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
const DEBUG = !!process.env.SENNHEISER_DEBUG;

interface ChannelState {
  name: string | null;
  rfBars: number | null;
  rfLevelDbm: number | null;
  battery: number | null;
  frequencyLabel: string | null;
  audioLevel: number | null;
  online: boolean;
}

function newChannelState(): ChannelState {
  return { name: null, rfBars: null, rfLevelDbm: null, battery: null, frequencyLabel: null, audioLevel: null, online: false };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class SennheiserEwG4 implements DeviceProvider {
  readonly id = "sennheiser-ewg4";
  readonly label = "Sennheiser ewG4 (SSC)";
  readonly configSchema: ConfigField[] = [];

  private host: string | null = null;
  private port = 45;
  private channelCount = 2;

  private socket: net.Socket | null = null;
  private buffer = "";
  private running = false;
  private reconnectMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connState: ConnectionState = "disconnected";

  private statusCb: ((s: DeviceStatus) => void) | null = null;
  private connCb: ((state: ConnectionState) => void) | null = null;
  private channels = new Map<number, ChannelState>();

  async connect(cfg: Record<string, unknown>): Promise<void> {
    this.host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    this.port = num(cfg.port) ?? 45;
    this.channelCount = Math.max(1, num(cfg.channels) ?? 2);
    this.channels.clear();
    for (let ch = 1; ch <= this.channelCount; ch++) this.channels.set(ch, newChannelState());
    this.running = true;
    this.open();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.markAllOffline();
    this.socket?.destroy();
    this.socket = null;
    this.setState("disconnected");
  }

  async listChannels(): Promise<DeviceChannel[]> {
    return [...this.channels.entries()].map(([ch, st]) => ({ id: String(ch), label: st.name ?? `Ch ${ch}` }));
  }

  onStatus(cb: (s: DeviceStatus) => void): void {
    this.statusCb = cb;
  }
  onConnectionStateChange(cb: (state: ConnectionState) => void): void {
    this.connCb = cb;
  }
  getConnectionState(): ConnectionState {
    return this.connState;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private setState(s: ConnectionState): void {
    if (s === this.connState) return;
    this.connState = s;
    this.connCb?.(s);
  }

  private open(): void {
    if (!this.running || !this.host) return;
    this.setState("connecting");
    const sock = net.createConnection({ host: this.host, port: this.port, timeout: CONNECT_TIMEOUT_MS });
    this.socket = sock;
    sock.setEncoding("utf8");

    sock.on("connect", () => {
      if (DEBUG) console.log(`[sennheiser:${this.id}] connected ${this.host}:${this.port}`);
      this.reconnectMs = RECONNECT_BASE_MS;
      sock.setTimeout(0);
      this.setState("connected");
      this.onConnected();
      this.startPolling();
    });
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("timeout", () => sock.destroy(new Error("connect timeout")));
    sock.on("error", (err) => {
      if (DEBUG) console.log(`[sennheiser:${this.id}] socket error:`, err.message);
    });
    sock.on("close", () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.markAllOffline();
      if (this.running) {
        this.setState("error");
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private send(obj: unknown): void {
    if (this.socket && !this.socket.destroyed) {
      const line = JSON.stringify(obj);
      if (DEBUG) console.log(`[sennheiser:${this.id}] → ${line}`);
      this.socket.write(line + "\r\n");
    }
  }

  // On connect, query the static per-channel fields (name, frequency) once.
  private onConnected(): void {
    for (let ch = 1; ch <= this.channelCount; ch++) {
      this.send({ [`rx${ch}`]: { name: null } });
      this.send({ [`rx${ch}`]: { frequency: null } });
    }
  }

  // Poll the changing values (RF, battery, audio) on a timer.
  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const poll = () => {
      for (let ch = 1; ch <= this.channelCount; ch++) {
        this.send({ [`rx${ch}`]: { rf: { level: null, quality: null }, bat: null, audio: { level: null } } });
      }
    };
    poll();
    this.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // SSC frames are JSON; devices delimit with newlines. Split tolerantly.
    let idx: number;
    while ((idx = this.buffer.search(/[\r\n]/)) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
    }
    if (this.buffer.length > 64_000) this.buffer = ""; // guard against a runaway non-delimited stream
  }

  private handleLine(line: string): void {
    if (DEBUG) console.log(`[sennheiser:${this.id}] ← ${line}`);
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON — ignore
    }
    if (!msg || typeof msg !== "object") return;
    const obj = msg as Record<string, unknown>;
    for (let ch = 1; ch <= this.channelCount; ch++) {
      const node = obj[`rx${ch}`];
      if (node && typeof node === "object") this.applyChannel(ch, node as Record<string, unknown>);
    }
  }

  // Map an SSC rx{n} node onto our channel state. Best-effort key names — kept
  // permissive so minor firmware differences still populate what they can.
  private applyChannel(ch: number, node: Record<string, unknown>): void {
    const st = this.channels.get(ch);
    if (!st) return;
    st.online = true;

    if (typeof node.name === "string") st.name = node.name;

    const freq = num(node.frequency) ?? num((node.frequency as Record<string, unknown>)?.["mhz"]);
    if (freq != null) st.frequencyLabel = `${(freq / (freq > 10000 ? 1000 : 1)).toFixed(3)} MHz`;

    const rf = node.rf as Record<string, unknown> | undefined;
    if (rf) {
      const lvl = num(rf.level);
      const quality = num(rf.quality);
      if (lvl != null) st.rfLevelDbm = lvl;
      // Prefer an explicit 0–100 quality; else map dBm (roughly -100..-50) → 0–5 bars.
      if (quality != null) st.rfBars = Math.max(0, Math.min(5, Math.round((quality / 100) * 5)));
      else if (lvl != null) st.rfBars = Math.max(0, Math.min(5, Math.round((lvl + 100) / 10)));
    }

    const bat = num(node.bat) ?? num((node.battery as Record<string, unknown>)?.["gauge"]) ?? num(node.battery);
    if (bat != null) st.battery = bat <= 5 ? bat * 20 : bat; // 0–5 gauge → %, else already %

    const audio = node.audio as Record<string, unknown> | undefined;
    const aLvl = num(audio?.level) ?? num(node.audio);
    if (aLvl != null) st.audioLevel = aLvl;

    this.emit(ch, st);
  }

  private emit(ch: number, st: ChannelState): void {
    this.statusCb?.({
      channelId: String(ch),
      name: st.name,
      deviceType: "receiver",
      online: st.online,
      rfBars: st.rfBars,
      rfLevelDbm: st.rfLevelDbm,
      battery: st.battery,
      charging: null,
      frequencyLabel: st.frequencyLabel,
      audioLevel: st.audioLevel,
      cycles: null,
      health: null,
      tempC: null,
      updatedAt: new Date().toISOString(),
    });
  }

  private markAllOffline(): void {
    for (const [ch, st] of this.channels) {
      st.online = false;
      this.emit(ch, st);
    }
  }
}
