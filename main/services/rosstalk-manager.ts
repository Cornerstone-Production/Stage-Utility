// rosstalk-manager.ts — owns RossTalk targets and their TCP connections.
//
// One persistent socket per enabled target (port 7788). The protocol is SEND-ONLY:
// nothing is parsed on read, incoming bytes are drained so the socket buffer cannot
// grow. Unlike OSC (UDP), a successful TCP connect genuinely proves reachability, so
// the badge here is honest.

import { randomUUID } from "node:crypto";
import * as net from "node:net";

import type { RossTalkFamily, RossTalkTarget, RossTalkTargetConfig } from "../types/rosstalk.js";
import { broadcast } from "./broadcaster.js";
import { ConnectionLifecycle } from "./integration-base.js";
import { ROSSTALK_COMMANDS, formatCommand, sanitiseRaw } from "./rosstalk-commands.js";
import { rosstalkStore } from "./rosstalk-store.js";

const DEFAULT_PORT = 7788;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;

/** One target's socket. */
class RossTalkConnection extends ConnectionLifecycle {
  private socket: net.Socket | null = null;
  private backoffAttempt = 0;
  private host: string | null = null;
  private port: number = DEFAULT_PORT;

  constructor(
    targetId: string,
    private readonly onState: (state: "connected" | "error" | "disconnected", message: string | null) => void,
  ) {
    // No SSE channel — RossTalk is an output; nothing subscribes to it.
    super("rosstalk", `rosstalk:${targetId}`);
    this.setConnectionListener((s, m) => this.onState(s, m));
  }

  configure(host: string | null, port: number): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : DEFAULT_PORT;
    this.resetReport();
    this.restart();
  }

  protected get configured(): boolean {
    return !!this.host;
  }

  protected override teardown(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  get isOpen(): boolean {
    return !!this.socket && !this.socket.destroyed && this.socket.writable;
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.host) return;
    const sock = net.connect({ host: this.host, port: this.port });
    sock.unref(); // an idle output socket must not hold the process open
    this.socket = sock;
    sock.on("connect", () => {
      this.backoffAttempt = 0;
      this.report("connected", `Connected to ${this.host}:${this.port}`);
    });
    // Send-only protocol: drain anything the device sends so the buffer can't grow.
    sock.on("data", () => {});
    sock.on("error", (err) => {
      if (this.attempt === 0) console.warn(`[rosstalk] ${this.host}:${this.port} unreachable (${err.message})`);
      this.report("error", `Can't reach ${this.host}:${this.port} — ${err.message}`);
    });
    sock.on("close", () => {
      if (this.socket === sock) this.socket = null;
      if (this.running) this.scheduleReconnect();
    });
  }

  /**
   * Keeps a fixed 30s ceiling rather than the shared window-aware cap. Nothing
   * subscribes to an output, so the shared cap reads it as dormant and stretches
   * retries toward 30 minutes — a switcher powered on mid-week would sit
   * unreachable that long. Same reasoning as tsl-service.
   */
  protected override scheduleReconnect(): void {
    if (!this.running) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.backoffAttempt);
    this.backoffAttempt++;
    this.scheduleIn(delay);
    // A waiting reconnect must not keep the process alive — otherwise a shutdown
    // (or a test run) hangs until the timer fires. The socket is unref'd for the
    // same reason in connect().
    this.unrefPending();
  }

  /** Let the event loop exit even with a retry queued or a socket open. */
  private unrefPending(): void {
    (this as unknown as { reconnectTimer?: { unref?: () => void } }).reconnectTimer?.unref?.();
  }

  write(line: string): void {
    if (!this.isOpen) throw new Error("RossTalk: target is not connected");
    this.socket!.write(line + "\r\n");
  }
}

class RossTalkManager {
  private targets: RossTalkTarget[] = [];
  private conns = new Map<string, RossTalkConnection>();
  private simulate = true;

  async init(): Promise<void> {
    const saved = await rosstalkStore.loadTargets();
    this.targets = saved.map((t) => ({ ...t, connection: "disconnected", message: null }));
    this.simulate = await rosstalkStore.loadSimulate();
    this.reapply();
  }

  /** Re-read targets from disk and reapply. Same reason as the OSC manager's:
   *  the view importer merges targets in behind this manager's back, and a
   *  stale in-memory array would be written back over them. */
  async reloadTargets(): Promise<void> {
    const saved = await rosstalkStore.loadTargets();
    this.targets = saved.map((t) => ({ ...t, connection: "disconnected", message: null }));
    this.reapply();
  }

  listTargets(): RossTalkTarget[] {
    return this.targets.map((t) => ({ ...t }));
  }

  getSimulate(): boolean {
    return this.simulate;
  }

  async setSimulate(on: boolean): Promise<{ simulate: boolean }> {
    this.simulate = on;
    await rosstalkStore.saveSimulate(on);
    this.broadcastTargets();
    return { simulate: on };
  }

  async addTarget(params: { name?: string }): Promise<RossTalkTarget[]> {
    const target: RossTalkTarget = {
      id: randomUUID(),
      name: params.name?.trim() || `RossTalk target ${this.targets.length + 1}`,
      enabled: false, // never dial out until the operator says so
      connection: "disconnected",
      message: null,
      config: { port: DEFAULT_PORT, family: "carbonite" },
    };
    this.targets.push(target);
    await this.persist();
    this.reapply();
    return this.listTargets();
  }

  async updateTarget(params: {
    id: string;
    patch: Partial<Pick<RossTalkTargetConfig, "name" | "enabled" | "config">>;
  }): Promise<RossTalkTarget[]> {
    const t = this.targets.find((x) => x.id === params.id);
    if (!t) throw new Error(`RossTalk: unknown target ${params.id}`);
    if (params.patch.name !== undefined) t.name = params.patch.name;
    if (params.patch.enabled !== undefined) t.enabled = params.patch.enabled;
    if (params.patch.config) t.config = { ...t.config, ...params.patch.config };
    await this.persist();
    this.reapply();
    return this.listTargets();
  }

  async removeTarget(params: { id: string }): Promise<RossTalkTarget[]> {
    this.conns.get(params.id)?.stop();
    this.conns.delete(params.id);
    this.targets = this.targets.filter((t) => t.id !== params.id);
    await this.persist();
    return this.listTargets();
  }

  /** Connect only. A probe packet would be a real command, so nothing is sent. */
  async testTarget(params: { id: string }): Promise<{ ok: boolean; message?: string }> {
    const t = this.targets.find((x) => x.id === params.id);
    if (!t) throw new Error(`RossTalk: unknown target ${params.id}`);
    const host = t.config.host?.trim();
    const port = Number(t.config.port) || DEFAULT_PORT;
    if (!host) return { ok: false, message: "No host set" };
    return new Promise((resolve) => {
      const sock = net.connect({ host, port, timeout: 4000 });
      const done = (ok: boolean, message: string) => {
        sock.destroy();
        resolve({ ok, message });
      };
      sock.on("connect", () => done(true, `Reachable at ${host}:${port} (nothing sent)`));
      sock.on("timeout", () => done(false, `Timed out reaching ${host}:${port}`));
      sock.on("error", (e) => done(false, e.message));
    });
  }

  /**
   * Validate, format, then either log (simulate) or write. Validation always runs
   * BEFORE the socket is touched: the protocol never replies, so a malformed command
   * would otherwise be a silent no-op on a live switcher.
   */
  async send(
    targetId: string,
    req: { commandId?: string; params?: Record<string, string | number>; raw?: string },
  ): Promise<{ ok: true; line: string; simulated: boolean }> {
    const t = this.targets.find((x) => x.id === targetId);
    if (!t) throw new Error(`RossTalk: unknown target ${targetId}`);

    let line: string;
    if (req.raw !== undefined) {
      line = sanitiseRaw(req.raw);
    } else if (req.commandId) {
      const cmd = ROSSTALK_COMMANDS[req.commandId];
      if (!cmd) throw new Error(`RossTalk: unknown command "${req.commandId}"`);
      const family: RossTalkFamily = t.config.family ?? "carbonite";
      if (cmd.family !== family) {
        throw new Error(
          `RossTalk: "${cmd.label}" is a ${cmd.family} command but target "${t.name}" is ${family}`,
        );
      }
      line = formatCommand(req.commandId, req.params ?? {});
    } else {
      throw new Error("RossTalk: send needs commandId or raw");
    }

    if (this.simulate) {
      console.log(`[rosstalk] SIMULATE ${t.name}: ${line}`);
      broadcast("rosstalk:simulated", { targetId, targetName: t.name, line, at: new Date().toISOString() });
      return { ok: true, line, simulated: true };
    }

    const conn = this.conns.get(targetId);
    if (!conn) throw new Error(`RossTalk: target "${t.name}" is not enabled`);
    conn.write(line);
    return { ok: true, line, simulated: false };
  }

  /** Stop every connection. Used on shutdown and by tests so the event loop can
   *  drain — without it a persistent socket keeps the process alive. */
  stopAll(): void {
    for (const conn of this.conns.values()) conn.stop();
    this.conns.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private reapply(): void {
    for (const t of this.targets) {
      const existing = this.conns.get(t.id);
      if (!t.enabled) {
        existing?.stop();
        this.conns.delete(t.id);
        continue;
      }
      const conn =
        existing ??
        new RossTalkConnection(t.id, (state, message) => {
          const target = this.targets.find((x) => x.id === t.id);
          if (!target) return;
          target.connection = state;
          target.message = message;
          this.broadcastTargets();
        });
      this.conns.set(t.id, conn);
      conn.configure(t.config.host ?? null, Number(t.config.port) || DEFAULT_PORT);
    }
  }

  private async persist(): Promise<void> {
    await rosstalkStore.saveTargets(
      this.targets.map(({ id, name, enabled, config }) => ({ id, name, enabled, config })),
    );
  }

  private broadcastTargets(): void {
    broadcast("rosstalk:targets-changed", { targets: this.listTargets(), simulate: this.simulate });
  }
}

export const rosstalkManager = new RossTalkManager();
