// osc-manager.ts — manages OSC target devices: a configurable list (like
// wireless-manager), one shared UDP send socket, and one shared UDP receive
// socket for feedback. Buttons on a custom layout POST to /api/osc/send which
// calls send(); incoming OSC is stored per (target,address) and broadcast on
// "osc:feedback" so buttons can reflect device state.
//
// OSC is connectionless UDP, so "connected" here means "configured & active"
// (ready to send) rather than a live link. Zero deps — Node's built-in dgram.

import { clamp } from "./clamp.js";
import { errorMessage } from "./errors.js";
import { randomUUID } from "node:crypto";
import * as dgram from "node:dgram";

import type { OscArg, OscFeedbackDTO, OscTarget, OscTargetConfig } from "../types/osc.js";
import { broadcast } from "./broadcaster.js";
import { decodePacket, encodeMessage } from "./osc-codec.js";
import { oscStore } from "./osc-store.js";
import { settingsStore } from "./settings-store.js";

const FEEDBACK_THROTTLE_MS = 200;

class OscManager {
  private targets: OscTarget[] = [];
  private sendSocket: dgram.Socket | null = null;
  private recvSocket: dgram.Socket | null = null;
  private feedbackPort = 9000;
  private feedback: Record<string, number | string | boolean> = {};
  private subTimers = new Map<string, ReturnType<typeof setInterval>>();
  private dirty = false;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Init ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    console.log("[osc] init");
    const settings = await settingsStore.load();
    this.feedbackPort = settings.oscFeedbackPort ?? 9000;
    const cfgs = await oscStore.load();
    this.targets = cfgs.map((c) => ({ ...c, connection: "disconnected" as const, message: null }));
    this.ensureSendSocket();
    this.reapply();
    this.bindFeedback();
    console.log(`[osc] init complete — ${this.targets.length} target(s), feedback port ${this.feedbackPort}`);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  listTargets(): OscTarget[] {
    return this.targets.map((t) => ({ ...t }));
  }

  getFeedback(): OscFeedbackDTO {
    return { values: { ...this.feedback } };
  }

  getFeedbackPort(): number {
    return this.feedbackPort;
  }

  async setFeedbackPort(port: number): Promise<{ port: number }> {
    const next = clamp(Math.floor(port), 1, 65535);
    this.feedbackPort = next;
    await settingsStore.patch({ oscFeedbackPort: next });
    this.bindFeedback();
    return { port: next };
  }

  /** Re-derive runtime state + restart subscribe keepalives (after enable/config). */
  reapply(): void {
    this.clearSubTimers();
    for (const t of this.targets) {
      const { host, port } = this.addrOf(t);
      if (!t.enabled) {
        t.connection = "disconnected";
        t.message = null;
      } else if (!host || !port) {
        t.connection = "error";
        t.message = "Host and port required";
      } else {
        t.connection = "connected";
        t.message = null;
        this.startSubscribe(t, host, port);
      }
    }
    this.broadcastTargets();
  }

  async addTarget(params: { name?: string }): Promise<OscTarget[]> {
    const index = this.targets.length + 1;
    const target: OscTarget = {
      id: randomUUID(),
      name: params.name?.trim() || `OSC target ${index}`,
      enabled: false,
      connection: "disconnected",
      message: null,
      config: { port: 8000 },
    };
    this.targets.push(target);
    await this.persist();
    this.reapply();
    return this.listTargets();
  }

  async updateTarget(params: {
    id: string;
    patch: Partial<Pick<OscTargetConfig, "name" | "enabled" | "config">>;
  }): Promise<OscTarget[]> {
    const t = this.targets.find((c) => c.id === params.id);
    if (!t) throw new Error(`osc:updateTarget — unknown id: ${params.id}`);
    const p = params.patch;
    if (p.name !== undefined) t.name = p.name.trim() || t.name;
    if (p.enabled !== undefined) t.enabled = p.enabled;
    if (p.config !== undefined) t.config = { ...t.config, ...p.config };
    await this.persist();
    this.reapply();
    return this.listTargets();
  }

  async removeTarget(params: { id: string }): Promise<OscTarget[]> {
    const idx = this.targets.findIndex((c) => c.id === params.id);
    if (idx === -1) throw new Error(`osc:removeTarget — unknown id: ${params.id}`);
    this.targets.splice(idx, 1);
    // Drop any feedback values held for the removed target.
    const prefix = `${params.id}::`;
    for (const k of Object.keys(this.feedback)) if (k.startsWith(prefix)) delete this.feedback[k];
    await this.persist();
    this.reapply();
    return this.listTargets();
  }

  /** Best-effort reachability check. UDP is connectionless, so a successful send
   *  only proves the host/port are usable + the packet left the box. */
  async testTarget(params: { id: string }): Promise<{ ok: boolean; message?: string }> {
    const t = this.targets.find((c) => c.id === params.id);
    if (!t) return { ok: false, message: "Unknown target" };
    const { host, port } = this.addrOf(t);
    if (!host || !port) return { ok: false, message: "Host and port required" };
    try {
      await this.sendRaw(host, port, encodeMessage(t.config.subscribeAddress || "/", []));
      return { ok: true, message: `Sent to ${host}:${port} (UDP — no delivery confirmation)` };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /** Send an OSC message to a target (called by the button → /api/osc/send). */
  async send(targetId: string, address: string, args: OscArg[] = []): Promise<{ ok: boolean }> {
    const t = this.targets.find((c) => c.id === targetId);
    if (!t) throw new Error(`osc:send — unknown target: ${targetId}`);
    const { host, port } = this.addrOf(t);
    if (!host || !port) throw new Error(`osc:send — target "${t.name}" has no host/port`);
    if (!address.startsWith("/")) throw new Error("OSC address must start with '/'");
    await this.sendRaw(host, port, encodeMessage(address, args));
    return { ok: true };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private addrOf(t: OscTarget): { host: string | null; port: number | null } {
    const host = typeof t.config.host === "string" && t.config.host.trim() ? t.config.host.trim() : null;
    // Port may arrive as a number or a numeric string (from the settings form).
    const portNum = Number(t.config.port);
    const port = Number.isFinite(portNum) && portNum > 0 ? Math.floor(portNum) : null;
    return { host, port };
  }

  private ensureSendSocket(): void {
    if (this.sendSocket) return;
    const s = dgram.createSocket("udp4");
    s.on("error", (e) => console.error("[osc] send socket error:", e));
    s.bind(); // ephemeral local port
    this.sendSocket = s;
  }

  private sendRaw(host: string, port: number, buf: Buffer): Promise<void> {
    this.ensureSendSocket();
    return new Promise((resolve, reject) => {
      this.sendSocket!.send(buf, port, host, (err) => (err ? reject(err) : resolve()));
    });
  }

  private startSubscribe(t: OscTarget, host: string, port: number): void {
    const addr = t.config.subscribeAddress;
    if (!addr) return;
    const intervalMs = Math.max(1, Math.floor(t.config.subscribeIntervalSec ?? 9)) * 1000;
    const fire = () => void this.sendRaw(host, port, encodeMessage(addr, [])).catch(() => {});
    fire();
    this.subTimers.set(t.id, setInterval(fire, intervalMs));
  }

  private clearSubTimers(): void {
    for (const timer of this.subTimers.values()) clearInterval(timer);
    this.subTimers.clear();
  }

  private bindFeedback(): void {
    this.closeRecv();
    const s = dgram.createSocket("udp4");
    s.on("error", (e) => console.error(`[osc] feedback socket error (port ${this.feedbackPort}):`, e));
    s.on("message", (msg, rinfo) => this.onFeedback(msg, rinfo.address));
    try {
      s.bind(this.feedbackPort, () => console.log(`[osc] feedback listening on udp/${this.feedbackPort}`));
      this.recvSocket = s;
    } catch (err) {
      console.error("[osc] could not bind feedback port:", err);
    }
  }

  private closeRecv(): void {
    if (this.recvSocket) {
      try {
        this.recvSocket.close();
      } catch {
        /* ignore */
      }
      this.recvSocket = null;
    }
  }

  private onFeedback(msg: Buffer, sourceIp: string): void {
    // Match the sender to a target by host (best-effort); also store under a
    // wildcard so a button can match regardless of which target replied.
    const target = this.targets.find((t) => this.addrOf(t).host === sourceIp);
    const tid = target?.id ?? "*";
    let changed = false;
    for (const m of decodePacket(msg)) {
      const v = m.args.length ? m.args[0] : true;
      if (v === null) continue;
      for (const key of [`${tid}::${m.address}`, `*::${m.address}`]) {
        if (this.feedback[key] !== v) {
          this.feedback[key] = v;
          changed = true;
        }
      }
    }
    if (changed) this.scheduleBroadcast();
  }

  private scheduleBroadcast(): void {
    this.dirty = true;
    if (this.throttleTimer) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.dirty) {
        this.dirty = false;
        broadcast("osc:feedback", this.getFeedback());
      }
    }, FEEDBACK_THROTTLE_MS);
  }

  private broadcastTargets(): void {
    broadcast("osc:targets-changed", this.listTargets());
  }

  private async persist(): Promise<void> {
    await oscStore.save(
      this.targets.map(({ id, name, enabled, config }) => ({ id, name, enabled, config })),
    );
  }
}

export const oscManager = new OscManager();
