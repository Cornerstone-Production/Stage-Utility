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
  /** The throttled `osc:feedback` broadcast in flight, if any. See
   *  whenBroadcastSettled(). Never rejects, same reasoning as `resolving` and
   *  `listening` below. */
  private broadcastSettled: Promise<void> = Promise.resolve();
  /** Resolved IP -> target id, for targets configured by hostname. Rebuilt on
   *  every reapply and refreshed on a timer. */
  private resolvedIps = new Map<string, string>();
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  /** The resolve pass in flight. See whenResolved(). */
  private resolving: Promise<void> = Promise.resolve();
  /** The feedback bind attempt in flight. See whenListening(). Never rejects —
   *  nothing internally awaits it, so a rejection nobody catches would be an
   *  unhandled rejection, same reasoning as `resolving` above. */
  private listening: Promise<void> = Promise.resolve();
  /** Null once bound; otherwise the reason the feedback socket is not
   *  listening, folded into every enabled target's connection state by
   *  reapply() so a later addTarget/updateTarget cannot silently paint back
   *  over it with a plain "connected". */
  private feedbackBindError: string | null = null;
  /** The port the current feedback socket actually bound, once bind()'s
   *  callback has run. Reset to null at the start of every bindFeedback() call
   *  so a stale value from a previous socket can never be read as current.
   *  Distinct from `feedbackPort`, which is the CONFIGURED port (0 means "let
   *  the OS choose" — see bindEphemeralFeedbackPort()); this is what actually
   *  ended up bound. */
  private boundPort: number | null = null;
  /** The last set of resolve failures reported, so a standing one is said once
   *  rather than every five minutes. */
  private lastResolveFailure = "";
  /** The same, for targets sharing one address. See warnAboutSharedAddresses. */
  private lastSharedAddress = "";
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

  /** The port feedback actually listens on: the socket's own bound port once
   *  bindFeedback() has settled, falling back to the configured value while a
   *  bind is still in flight (or has failed outright). Only bindEphemeral-
   *  FeedbackPort() ever configures 0 — production always has a concrete
   *  configured port from settings, so the two agree there in practice. */
  getFeedbackPort(): number {
    return this.boundPort ?? this.feedbackPort;
  }

  async setFeedbackPort(port: number): Promise<{ port: number }> {
    const next = clamp(Math.floor(port), 1, 65535);
    this.feedbackPort = next;
    await settingsStore.patch({ oscFeedbackPort: next });
    this.bindFeedback();
    return { port: next };
  }

  /**
   * Re-derive runtime state + restart subscribe keepalives (after enable/config).
   *
   * The ONE place `t.connection`/`t.message` are decided, on purpose: a bind
   * failure on the shared feedback socket used to be visible only in the log,
   * because nothing that runs afterward — addTarget, updateTarget, a target
   * reload — consulted it, so any of them would paint every card back to a
   * plain green "connected" the next time they ran. Folding
   * `feedbackBindError` in here means there is nowhere left for that to happen
   * by accident.
   */
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
        // Sending is a different socket and does not depend on the feedback
        // bind below, so the keepalive runs regardless of whether it succeeded.
        this.startSubscribe(t, host, port);
        if (this.feedbackBindError) {
          t.connection = "error";
          t.message = `feedback port ${this.feedbackPort} unavailable (${this.feedbackBindError}) — sending still works`;
        } else {
          t.connection = "connected";
          t.message = null;
        }
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
        // Deliberate, and the same shape closeRecv() has always had: this runs
        // during shutdown, dgram throws only when the socket is already closed,
        // and there is no caller left who could act on it.
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
    this.resolveTimer = setInterval(() => {
      this.resolving = this.safeResolve();
    }, RESOLVE_INTERVAL_MS);
    this.resolving = this.safeResolve();
  }

  /**
   * Exposed for tests — the resolve pass in flight, if any.
   *
   * Nothing in the server waits for it, and nothing should: it is a background
   * refresh and no request may block on DNS. But a test that delivers a packet
   * from a hostname target's address has to know the mapping has landed, and
   * sleeping a fixed number of milliseconds for an async chain is how a guard
   * becomes a coin toss on a loaded machine. This one did, once.
   */
  whenResolved(): Promise<void> {
    return this.resolving;
  }

  /**
   * The end of the chain, so a throw stops here.
   *
   * Not a swallow: reportResolve is the top of a background task started by a
   * timer, so there is no caller above it to hand a failure to and nothing
   * downstream that could act on one. What there IS, without this, is an
   * unhandled rejection from a timer nobody owns — which on this Node takes the
   * process down. resolveHosts already returns its DNS failures rather than
   * throwing them; this covers everything else.
   */
  private async safeResolve(): Promise<void> {
    try {
      await this.reportResolve();
    } catch (err) {
      console.error(`[osc] the hostname resolve pass failed outright: ${errorMessage(err)}`);
    }
  }

  /**
   * The only caller that can act on a resolve failure, and all it can do is say
   * so — the target keeps working for SEND (dgram resolves the hostname itself);
   * what it loses is being told apart from every other sender.
   *
   * Said when it CHANGES, not every pass. A name that will never resolve is a
   * standing condition, and a warning repeated every five minutes for the rest
   * of the week is a log an operator learns to scroll past.
   */
  private async reportResolve(): Promise<void> {
    const { resolved, failed } = await this.resolveHosts();
    const key = failed.join("; ");
    if (key !== this.lastResolveFailure) {
      this.lastResolveFailure = key;
      if (failed.length > 0) {
        console.warn(
          `[osc] could not resolve ${key} — feedback from ` +
            `${failed.length === 1 ? "it" : "them"} lands under the wildcard only`,
        );
      }
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
        // FIRST CONFIGURED WINS, matching the literal lookup below, which is a
        // `find`. Two targets on one address can only ever have one of them
        // attributed, and the two tie-breaks disagreeing would make WHICH one
        // depend on whether the target was typed as a name or an address.
        for (const ip of await oscDeps.lookup(host)) if (!next.has(ip)) next.set(ip, t.id);
      } catch (err) {
        failed.push(`${t.name} (${host}): ${errorMessage(err)}`);
      }
    }
    this.warnAboutSharedAddresses();
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
   * one exists: `"console.local" === "192.0.2.5"` is never true, so its values
   * landed under the wildcard alone and neither a button nor a rule could tell
   * it from any other sender on the network.
   */
  private resolveTargetId(sourceIp: string): string {
    const literal = this.targets.find((t) => this.addrOf(t).host === sourceIp);
    return literal?.id ?? this.resolvedIps.get(sourceIp) ?? "*";
  }

  /**
   * Two enabled targets configured with the same address.
   *
   * A packet carries a source ADDRESS and no port, so there is nothing in it to
   * tell an X32 entry for sending from a second entry for its /xremote
   * subscribe, or QLab from Companion on one Mac. Only the first target gets
   * its own key; the rest are reachable only through the wildcard.
   *
   * A layout BUTTON survives that — resolveOscActive falls back to the wildcard.
   * A RULE does not: a trigger scoped to the second target builds one key, that
   * key is never written, and the rule fires never with nothing anywhere saying
   * why. Which is what this line is for.
   */
  private warnAboutSharedAddresses(): void {
    const byAddress = new Map<string, string[]>();
    for (const t of this.targets) {
      if (!t.enabled) continue;
      const { host } = this.addrOf(t);
      if (!host) continue;
      const ip = isIP(host) ? host : [...this.resolvedIps].find(([, id]) => id === t.id)?.[0];
      if (!ip) continue;
      byAddress.set(ip, [...(byAddress.get(ip) ?? []), t.name]);
    }
    const shared = [...byAddress]
      .filter(([, names]) => names.length > 1)
      .map(([ip, names]) => `${ip} (${names.join(", ")})`)
      .sort();
    const key = shared.join("; ");
    if (key === this.lastSharedAddress) return;
    this.lastSharedAddress = key;
    if (shared.length > 0) {
      console.warn(
        `[osc] more than one enabled target sends from ${key} — a packet carries no port, so ` +
          "only the first is attributed and a rule scoped to the others will never fire",
      );
    }
  }

  private bindFeedback(): void {
    this.closeRecv();
    this.boundPort = null;
    const s = dgram.createSocket("udp4");
    let settle = (): void => {};
    this.listening = new Promise((resolve) => {
      settle = resolve;
    });
    // dgram reports almost every bind failure — EADDRINUSE chief among them —
    // on this EVENT, asynchronously, never by throwing. The try/catch below
    // catches only the rare synchronous throw (a malformed call), so this is
    // the one that actually fires for a port already taken, and the one that
    // used to only log: `this.recvSocket = s` below still ran, leaving every
    // enabled target's card reporting "connected" with feedback silently gone
    // for good.
    s.on("error", (e) => {
      console.error(`[osc] feedback socket error (port ${this.feedbackPort}):`, e);
      this.reportFeedbackBind(errorMessage(e));
      settle();
    });
    s.on("message", (msg, rinfo) => this.receive(msg, rinfo.address));
    try {
      s.bind(this.feedbackPort, () => {
        this.boundPort = (s.address() as { port: number }).port;
        console.log(`[osc] feedback listening on udp/${this.boundPort}`);
        this.reportFeedbackBind(null);
        settle();
      });
      this.recvSocket = s;
    } catch (err) {
      console.error("[osc] could not bind feedback port:", err);
      this.reportFeedbackBind(errorMessage(err));
      settle();
    }
  }

  /**
   * Test seam only: bind the feedback socket on an OS-assigned port and hand
   * back the port actually bound, once listening.
   *
   * Production always binds a concrete configured port loaded from settings —
   * nothing here ever passes 0 outside a test. Two test files used to each
   * find a free port by binding 0, closing that probe socket, and then
   * configuring the manager with the number it read back. That close-then-
   * reopen has a gap: under CI's parallel `node --test` workers, another
   * worker's OWN probe can be handed the exact same just-freed port before
   * either side reclaims it, and one process's feedback socket steals the
   * other's port (or a stray datagram lands on the wrong process entirely —
   * the swallowed-BANG flake this replaced). Binding here with 0 closes the
   * gap: there is only one bind, and the port comes back from the real socket
   * that now owns it, never from a probe that already let it go.
   */
  async bindEphemeralFeedbackPort(): Promise<number> {
    this.feedbackPort = 0;
    this.bindFeedback();
    await this.whenListening();
    if (this.feedbackBindError) {
      throw new Error(`ephemeral feedback bind failed: ${this.feedbackBindError}`);
    }
    return this.boundPort!;
  }

  /**
   * Resolves once the feedback bind from the most recent bindFeedback() call
   * has settled — listening, or given up — never rejects.
   *
   * The same seam whenResolved() provides for DNS: the bind is asynchronous
   * with no callback the constructor can await, so a caller that needs to know
   * whether a datagram sent right now has anywhere to land has nothing else to
   * wait on. A test that sent one before this existed had to retry for up to 3
   * seconds instead, because there was nothing else to wait on.
   */
  whenListening(): Promise<void> {
    return this.listening;
  }

  /**
   * Record the outcome of a bind attempt and re-derive every target's
   * connection state from it via reapply() — the one place that decides
   * `t.connection`, so this cannot be silently overwritten by the next
   * addTarget/updateTarget the way a direct assignment here could be.
   *
   * Said — and reapplied — only when the outcome CHANGES, not on every rebind
   * with the same one: a port that stays taken is a standing condition, and
   * reapply() rebuilds every target and restarts every keepalive timer, which
   * is not free to do on every unrelated config change once this is already
   * known.
   */
  private reportFeedbackBind(error: string | null): void {
    if (error === this.feedbackBindError) return;
    this.feedbackBindError = error;
    this.reapply();
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
    for (let i = Math.max(args.length, 1); i < MAX_ARGS; i++) {
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
    let settle = (): void => {};
    this.broadcastSettled = new Promise((resolve) => {
      settle = resolve;
    });
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.dirty) {
        this.dirty = false;
        broadcast("osc:feedback", this.getFeedback());
      }
      settle();
    }, FEEDBACK_THROTTLE_MS);
  }

  /**
   * Resolves once the throttled `osc:feedback` broadcast this receive() burst
   * scheduled has actually gone out (or immediately, if nothing is pending).
   *
   * A test that drives receive() directly — automation-osc-trigger.test.ts —
   * still trips this SAME throttle underneath, on its own
   * FEEDBACK_THROTTLE_MS timer, independent of whatever the test does next.
   * Left undrained, that stray real broadcast reaches automationEngine's
   * live subscription (started once, in init()) up to 200ms later — often
   * during the NEXT test, after its beforeEach has already reset rules but
   * before it has cleared `prev` — and gets evaluated as if it were that
   * test's own first snapshot. That is what let a bang-on-a-fresh-channel
   * case see a baseline it never sent. See the test file's beforeEach.
   */
  whenBroadcastSettled(): Promise<void> {
    return this.broadcastSettled;
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
