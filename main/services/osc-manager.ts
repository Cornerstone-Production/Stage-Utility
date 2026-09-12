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
import * as dns from "node:dns/promises";
import { isIP } from "node:net";

import type { OscArg, OscFeedbackDTO, OscTarget, OscTargetConfig } from "../types/osc.js";
import { broadcast } from "./broadcaster.js";
import { decodePacket, encodeMessage } from "./osc-codec.js";
import { oscStore } from "./osc-store.js";
import { settingsStore } from "./settings-store.js";

const FEEDBACK_THROTTLE_MS = 200;

/** The one seam: tests resolve hostnames without asking a DNS server. */
export const oscDeps: { lookup: (hostname: string) => Promise<string[]> } = {
  lookup: async (hostname) => (await dns.lookup(hostname, { all: true })).map((a) => a.address),
};

/** How often hostname-configured targets are re-resolved. Consoles sit on DHCP,
 *  and a stale map is a target's feedback quietly falling back to the wildcard. */
const RESOLVE_INTERVAL_MS = 5 * 60_000;

/**
 * How many arguments of one message are stored.
 *
 * There is no eviction on the feedback map — an X32 under `/xremote` already
 * fills it with several hundred addresses — so keeping every argument of every
 * message would multiply that by whatever the busiest reply carries. Eight
 * covers the shapes gear actually sends (a channel and a value; a colour, a
 * name and a level) with room to spare.
 */
const MAX_ARGS = 8;

class OscManager {
  private targets: OscTarget[] = [];
  private sendSocket: dgram.Socket | null = null;
  private recvSocket: dgram.Socket | null = null;
  private feedbackPort = 9000;
  private feedback: Record<string, number | string | boolean> = {};
  private subTimers = new Map<string, ReturnType<typeof setInterval>>();
  private dirty = false;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolved IP -> target id, for targets configured by hostname. Rebuilt on
   *  every reapply and refreshed on a timer. */
  private resolvedIps = new Map<string, string>();
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  /** Said once per process: a device sending more than MAX_ARGS is a standing
   *  condition, not an event, and one line per packet would bury the log. */
  private warnedLongMessage = false;

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

  /**
   * Re-read targets from disk and reapply.
   *
   * For a writer that legitimately bypasses this manager — the view importer
   * merges targets in as part of a bundle. Without this the manager keeps its
   * stale in-memory array, so an imported target is not live AND the next
   * persist() writes that array back over the file, erasing it.
   */
  async reloadTargets(): Promise<void> {
    const cfgs = await oscStore.load();
    this.targets = cfgs.map((c) => ({ ...c, connection: "disconnected" as const, message: null }));
    this.reapply();
    this.bindFeedback();
  }

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
    this.startResolving();
    this.broadcastTargets();
  }

  /**
   * Close both sockets and stop every timer.
   *
   * Called from the server's shutdown handler beside every other integration's
   * stop(), which this was missing from. It is also what lets a test drive
   * receive() without leaving a bound UDP socket holding the event loop open.
   */
  stop(): void {
    this.clearSubTimers();
    if (this.resolveTimer) {
      clearInterval(this.resolveTimer);
      this.resolveTimer = null;
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.closeRecv();
    if (this.sendSocket) {
      try {
        this.sendSocket.close();
      } catch {
        /* already closed */
      }
      this.sendSocket = null;
    }
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

  /** Resolve hostname targets now, and keep them resolved. */
  private startResolving(): void {
    if (this.resolveTimer) clearInterval(this.resolveTimer);
    this.resolveTimer = setInterval(() => void this.reportResolve(), RESOLVE_INTERVAL_MS);
    void this.reportResolve();
  }

  /** The only caller that can act on a resolve failure, and all it can do is
   *  say so — the target keeps working for SEND (dgram resolves the hostname
   *  itself); what it loses is being told apart from every other sender. */
  private async reportResolve(): Promise<void> {
    const { resolved, failed } = await this.resolveHosts();
    if (failed.length > 0) {
      console.warn(
        `[osc] could not resolve ${failed.join("; ")} — feedback from ` +
          `${failed.length === 1 ? "it" : "them"} lands under the wildcard only`,
      );
    }
    if (resolved > 0) console.log(`[osc] ${resolved} address(es) resolved for hostname targets`);
  }

  /**
   * Map every hostname-configured target to the addresses it may send from.
   *
   * PARTIAL BY DESIGN: one unresolvable target must not cost the others their
   * mapping, so the failures come back to the caller rather than aborting the
   * pass. Targets configured with a literal IP never reach DNS — resolveTargetId
   * matches those on the string, exactly as it always has.
   */
  private async resolveHosts(): Promise<{ resolved: number; failed: string[] }> {
    const next = new Map<string, string>();
    const failed: string[] = [];
    for (const t of this.targets) {
      const { host } = this.addrOf(t);
      if (!host || isIP(host)) continue;
      try {
        for (const ip of await oscDeps.lookup(host)) next.set(ip, t.id);
      } catch (err) {
        failed.push(`${t.name} (${host}): ${errorMessage(err)}`);
      }
    }
    // Logged only when it CHANGES: a five-minute refresh that says the same
    // thing forever is noise an operator learns to scroll past.
    const changed =
      next.size !== this.resolvedIps.size || [...next].some(([ip, id]) => this.resolvedIps.get(ip) !== id);
    this.resolvedIps = next;
    return { resolved: changed ? next.size : 0, failed };
  }

  /**
   * Which configured target sent this packet?
   *
   * The literal host match comes FIRST — that is what every IP-configured target
   * has always used, and it does not wait on a DNS pass having finished. A
   * target configured by NAME falls through to the resolved map, which is why
   * one exists: `"console.local" === "10.0.0.5"` is never true, so its values
   * landed under the wildcard alone and neither a button nor a rule could tell
   * it from any other sender on the network.
   */
  private resolveTargetId(sourceIp: string): string {
    const literal = this.targets.find((t) => this.addrOf(t).host === sourceIp);
    return literal?.id ?? this.resolvedIps.get(sourceIp) ?? "*";
  }

  private bindFeedback(): void {
    this.closeRecv();
    const s = dgram.createSocket("udp4");
    s.on("error", (e) => console.error(`[osc] feedback socket error (port ${this.feedbackPort}):`, e));
    s.on("message", (msg, rinfo) => this.receive(msg, rinfo.address));
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

  /**
   * Ingest one received packet.
   *
   * The feedback socket is the only caller in the server; a test calls it
   * directly rather than binding a port and sending itself a datagram.
   *
   * Values are stored under the sending target AND under a `*` wildcard, so a
   * button or a rule can match regardless of which target replied.
   */
  receive(msg: Buffer, sourceIp: string): void {
    const tid = this.resolveTargetId(sourceIp);
    let changed = false;
    for (const m of decodePacket(msg)) {
      // A message with NO arguments is a bang: `true`, exactly as before.
      const args = m.args.length > 0 ? m.args.slice(0, MAX_ARGS) : [true];
      if (m.args.length > MAX_ARGS && !this.warnedLongMessage) {
        this.warnedLongMessage = true;
        console.warn(
          `[osc] ${m.address} carries ${m.args.length} arguments — only the first ${MAX_ARGS} ` +
            "are kept, so a rule cannot watch the rest (said once per run)",
        );
      }
      for (const prefix of [tid, "*"]) changed = this.store(`${prefix}::${m.address}`, args) || changed;
    }
    if (changed) this.scheduleBroadcast();
  }

  /**
   * Store one message's arguments, and drop whatever a longer earlier message
   * left above them.
   *
   * ARGUMENT 0 KEEPS THE BARE KEY. A layout button binds to
   * `targetId::address`, so every single-argument message in use today lands
   * exactly where it always did; only arguments 1 and up are new, and they take
   * a `#N` suffix. `#` cannot collide with a real address — OSC 1.0 excludes it
   * from address patterns, along with space, `*`, `,`, `/`, `?`, `[`, `]`, `{`
   * and `}`.
   *
   * A NULL argument (OSC `N`, or a blob, whose contents this codec does not
   * surface) is skipped rather than stored or erased, which is what the
   * single-argument path did before there was more than one argument. The
   * device has told us it has no value for that slot; the last real one it sent
   * is still the best answer.
   */
  private store(base: string, args: (number | string | boolean | null)[]): boolean {
    let changed = false;
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      if (v === null || v === undefined) continue;
      const key = i === 0 ? base : `${base}#${i}`;
      if (this.feedback[key] !== v) {
        this.feedback[key] = v;
        changed = true;
      }
    }
    // Stale trailing arguments. `/x 1 2 3` followed by `/x 1` would otherwise
    // leave `#1` and `#2` reading as current, and a rule watching `#1` would
    // cross a threshold on a value nothing has sent for an hour. Swept to
    // MAX_ARGS rather than "up to the first gap", so a null in the middle of an
    // earlier message cannot strand a key above it.
    for (let i = Math.max(args.length, 1); i <= MAX_ARGS; i++) {
      const key = `${base}#${i}`;
      if (!(key in this.feedback)) continue;
      delete this.feedback[key];
      changed = true;
    }
    return changed;
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
