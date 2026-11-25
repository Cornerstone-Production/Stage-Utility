// qsys-write.ts — the one way a value reaches a Q-SYS control.
//
// Every write is checked here, never in a browser: the control must be on the
// allowlist, the connection must be live AND have read the Core's current state
// since it (re)connected (qsysWatch.ready()), and the value must suit the
// control. A numeric value outside the entry's limits is clamped; a numeric write
// to an entry with no limits is refused. Booleans and triggers carry no range.
//
// Nothing is queued or replayed. A write that arrives while the Core is offline,
// reconnecting or being re-read is refused with "offline" and forgotten; only a
// fresh touch writes again. The readiness check and the send happen in one
// synchronous stretch on the same transport, so a reconnect cannot slip between
// them.
//
// Every write goes as `Component.Set` with `ResponseValues: true`, and the
// Core's answer is what the caller gets back. A read-back that differs from what
// was sent is logged. A refusal is always a write-log entry; a write that landed
// is one when it is its gesture's last (`final` not false), and its `from` is the
// value when the gesture started. Refusals checked before sending write their
// [qsys] line at a limited rate (an OutageLog: see refusalLine).

import { addStreamClosedListener, connectionOf } from "../broadcaster.js";
import { viewsStore } from "../views-store.js";
import { errorMessage } from "../errors.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import { addressKey, choicesOf, isWritable, kindOf, panelHasMomentary, panelHasSelectorOn, type QsysControlKind, unwritableReason } from "../../types/qsys.js";
import type { View } from "../../types/views.js";

// The rules live in types/qsys.ts so the editor shares them; re-exported for the server.
export { isWritable, kindOf, unwritableReason };
import { QrcError, type QrcTransport } from "./qrc-client.js";
import type { QrcControl } from "./qrc-types.js";
import { isAddressPart, qsysAllowlist } from "./qsys-allowlist-store.js";
import { qsysService, type QsysCatalog } from "./qsys-service.js";
import { qsysWatch } from "./qsys-watch.js";
import { LatencyWindow, type LatencyStats } from "./qsys-latency.js";
import { QsysLeases, type Lease, type LeaseEnd, type ReleaseCause } from "./qsys-leases.js";
import { PRE_SEND_REFUSALS, qsysWriteLog } from "./qsys-write-log.js";

export interface WriteRequest {
  component: string;
  control: string;
  value: number | boolean | string;
  panelId: string | null;
  /** Who asked: the request's address and user agent. */
  device: string;
  /**
   * The request's remote address alone. Refusal lines are rate-limited and
   * repeated refusals merged by it, not by `device`: the user agent is the
   * client's to choose, so a key containing it could be changed per request.
   */
  remote: string;
  /**
   * False for a write in the middle of a gesture (a fader drag). Such a write is
   * checked and sent like any other, but when it succeeds it leaves no write-log
   * entry and no clamp or mismatch line: the gesture's last write (final true or
   * absent) records it. A refusal is always recorded.
   */
  final?: boolean;
  /**
   * A momentary press (true to a Boolean) that the page will renew while held.
   * When it lands, the server holds a lease and releases the control itself if
   * the renewals stop or the connection `cid` pressed on closes (qsys-leases.ts).
   * A press that asks for a lease it cannot have (no momentary button for it on
   * the panel, or the saved views unreadable) is refused `no-lease`, unsent.
   */
  lease?: boolean;
  /** The pressing page's event-stream client id, so its stream closing ends the lease. */
  cid?: string | null;
  /** Why the server wrote this itself (a lease ending, or a release owed); in the write log. */
  cause?: ReleaseCause;
}

export type WriteRefusal = "not-allowed" | "not-in-design" | "read-only" | "no-range" | "offline" | "bad-value" | "core-error" | "no-lease";

export type WriteResult =
  | { ok: true; value: unknown; string: string; position?: number; clamped: boolean }
  | { ok: false; reason: WriteRefusal; message: string };

/** What the writer needs from the connection. QsysService satisfies it. */
export interface WriteSource {
  readonly transport: QrcTransport | null;
  /** Which Core the settings name; a release owed to one Core is never sent to another. */
  readonly core: string | null;
  getCatalog(): QsysCatalog | null;
  /** Each time the connection is torn down; the hourly latency timer is cleared from here. Optional for stand-ins. */
  onDisconnect?(cb: () => void): () => void;
}

/** What the writer needs from the watch. QsysWatch satisfies it. */
export interface WriteReadiness {
  ready(): boolean;
  current(addresses: { component: string; control: string }[]): Map<string, { Value: unknown }>;
  /** Each time writes become possible again; where an owed release is sent. Optional for stand-ins. */
  onReady?(cb: () => void): () => void;
}

/** A refusal line already written is not repeated for this long, unless its state changed. */
export const REFUSAL_LINE_INTERVAL_MS = 60_000;
/** How long a gesture's starting value is kept waiting for its last write. */
export const GESTURE_TIMEOUT_MS = 10_000;
/** Open gestures remembered at once; past it the oldest is dropped. */
const MAX_GESTURES = 256;

/** The longest text value a write may carry. */
const MAX_TEXT = 1024;
/** Tries at settling one owed release (a failed read, a failed send) before it is given up, logged. The Core being offline is not a try. */
export const OWED_MAX_ATTEMPTS = 5;
/** On a live connection a failed try is retried after this, doubling each time. */
export const OWED_RETRY_MS = 500;

/** How often the write latency is written to the log, while connected and only if there were writes. */
export const LATENCY_LINE_INTERVAL_MS = 60 * 60_000;

/** A numeric read-back this close to what was sent is the same value (the Core's float precision is unverified). */
const READBACK_TOLERANCE = 0.01;

type Kind = QsysControlKind;

type Refused = Extract<WriteResult, { ok: false }>;
type Checked = { ok: true; send: number | boolean | string; clamped: boolean } | Refused;
const badValue = (message: string): Refused => ({ ok: false, reason: "bad-value", message });

/** Per kind: what a value must be (min/max are set wherever a range is needed),
 *  and whether a read-back is the value sent. */
const KINDS: Record<Kind, { check(value: unknown, min: number, max: number, where: string): Checked; same(sent: unknown, got: unknown): boolean }> = {
  boolean: {
    check: (value, _min, _max, where) => (typeof value === "boolean" ? { ok: true, send: value, clamped: false } : badValue(`${where} takes true or false`)),
    same: (sent, got) => sent === (got === true || got === 1),
  },
  trigger: {
    // QRC fires a trigger on any Set; 1 is what the reference shows. A State Trigger
    // (a snapshot's load.N) is sent 1 too: it is a trigger to the writer, and whether a
    // Core loads the snapshot on 1 is on the spec's list to re-check in Emulate.
    check: (value, _min, _max, where) => (value === true || value === 1 ? { ok: true, send: 1, clamped: false } : badValue(`${where} is a trigger; send true`)),
    same: () => true,
  },
  text: {
    check: (value, _min, _max, where) =>
      typeof value === "string" && value.length <= MAX_TEXT
        ? { ok: true, send: value, clamped: false }
        : badValue(`${where} takes text of up to ${MAX_TEXT} characters`),
    same: (sent, got) => got === sent,
  },
  number: {
    check: (value, min, max, where) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return badValue(`${where} takes a finite number`);
      const send = Math.min(max, Math.max(min, value));
      return { ok: true, send, clamped: send !== value };
    },
    same: (sent, got) => typeof got === "number" && Math.abs(got - (sent as number)) <= READBACK_TOLERANCE,
  },
};

/** The rules for a control that reports its choices: a text that is one of them, sent as it is. */
function choiceKind(choices: string[]): (typeof KINDS)[Kind] {
  return {
    check: (value, _min, _max, where) =>
      typeof value === "string" && choices.includes(value) ? { ok: true, send: value, clamped: false } : badValue(`${where} takes one of the choices the Core lists`),
    same: (sent, got) => got === sent || String(got) === sent,
  };
}

/** A value fit for the log: what the request carried, bounded. */
function loggable(v: unknown): unknown {
  if (typeof v === "string") return v.slice(0, MAX_TEXT);
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  return null;
}

type ReadBack = { Name?: unknown; Value?: unknown; String?: unknown; Position?: unknown };

/**
 * The entry for `control` in a Component.Set reply with ResponseValues. A Core
 * answers with a bare list of `{ Component, Name, String, Value, Position }`
 * (Designer 10.0.1 Emulate); the `{ Name, Controls: [...] }` form QSC's page
 * shows is taken too.
 */
export function readBack(reply: unknown, control: string): ReadBack | undefined {
  const list = Array.isArray(reply) ? reply : (reply as { Controls?: unknown } | null)?.Controls;
  return Array.isArray(list) ? (list as (ReadBack | null)[]).find((x) => x?.Name === control) ?? undefined : undefined;
}

function findControl(catalog: QsysCatalog, component: string, control: string): QrcControl | undefined {
  return catalog.components.find((c) => c.name === component)?.controls.find((c) => c.Name === control);
}

/** Refusal messages, by reason, for refusals unwritableReason gives. */
const UNWRITABLE_MESSAGE: Record<"read-only" | "no-range", (where: string) => string> = {
  "read-only": (where) => `${where} is read-only on the Core`,
  "no-range": (where) => `${where} has no write range set on the allowlist`,
};

/** A gesture's starting value, waiting for the gesture's last write. */
type Gesture = { from: unknown; at: number };

/**
 * A release the server decided to send: its place in the control's sends. It
 * goes only if nothing else has been sent to the control since (`seq` is the
 * control's last send when it was decided, then its own once it sends). The check
 * is made in write's synchronous stretch, next to the send, so a fresh press that
 * reaches the Core first always wins.
 */
interface ReleaseToken {
  seq: number;
}

/** A release the server could not send, kept until writes are possible again. */
interface Owed {
  lease: Lease;
  token: ReleaseToken;
  /** Tries that ended without settling it (an unreadable control, a failed send); the Core being away is not one. */
  attempts: number;
  /** One settle at a time per entry. */
  settling: boolean;
  retry: ReturnType<typeof setTimeout> | null;
}

/** What run() answers for a server release that another write got to first: nothing was sent. */
const SUPERSEDED = "superseded";

export class QsysWriter {
  /**
   * Refusals checked before anything is sent can arrive at drag rate, or from a
   * client looping on a bad request. Keyed by reason, with the remote address as
   * the kind: the first refusal of each remote is written, then one reminder a
   * minute with the count; past eight remotes in a run they share one bucket, so
   * a client cycling addresses cannot talk once per request. Offline is one
   * connection-wide state: its kind is the connection, so a new connection (or
   * none) is news, and readiness coming back ends the run. A refusal from the
   * Core itself is always written.
   */
  private readonly refusals = new OutageLog(REFUSAL_LINE_INTERVAL_MS, REFUSAL_LINE_INTERVAL_MS);
  /** An id per connection, for the offline line's kind. */
  private readonly connections = new WeakMap<object, number>();
  private nextConnection = 1;
  /** Open gestures by remote, panel and address, oldest first. */
  private readonly gestures = new Map<string, Gesture>();

  /** Momentary presses the server will release if the page cannot. */
  readonly leases = new QsysLeases((lease, why) => void this.releaseLease(lease, why));
  /**
   * Releases the server could not send (the Core away, or the send failed), by
   * address. A fail-safe to off, not a replay: when writes are possible again the
   * control is read, and the release goes only if the Core still reports it on.
   * Any other write that reaches the control first settles it. Dropped, with a
   * line, when the Core, its design or the allowlist no longer matches, or after
   * OWED_MAX_ATTEMPTS tries.
   */
  private readonly owed = new Map<string, Owed>();
  /** Each control's last send, by address: a server release goes only if it is still its own (ReleaseToken). */
  private readonly lastSend = new Map<string, number>();
  private sendSeq = 0;
  /**
   * The saved views, for what a write's panel holds: whether it has a momentary
   * button on the control (only then does a press take a lease) and whether it
   * has a selector on it (only then is the write held to the Core's choices).
   * Strict: an unreadable views file throws rather than reading as no panels,
   * and the decision that needed it refuses. Replaceable for tests.
   */
  loadViews: () => Promise<View[]> = () => viewsStore.loadStrict();
  private readonly stopListening: () => void;
  private readonly stopDisconnectListening: () => void;
  /** Send-to-reply time of each write the Core answered. */
  private readonly confirmLatency = new LatencyWindow();
  /** The hourly latency line's timer: armed by a write, so none runs while nothing is written. */
  private latencyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: WriteSource,
    private readonly watch: WriteReadiness,
    private readonly now: () => number = Date.now,
  ) {
    this.stopListening = watch.onReady?.(() => void this.sendOwed()) ?? (() => {});
    this.stopDisconnectListening = source.onDisconnect?.(() => this.clearLatencyTimer()) ?? (() => {});
  }

  /** Stop hearing readiness and forget every lease and owed release; for tests and shutdown. */
  dispose(): void {
    this.stopListening();
    this.stopDisconnectListening();
    this.clearLatencyTimer();
    this.leases.clear();
    for (const o of this.owed.values()) if (o.retry) clearTimeout(o.retry);
    this.owed.clear();
  }

  /** Write confirm time (send to the Core's reply) over the last writes, for the status. */
  latencyStats(): LatencyStats {
    return this.confirmLatency.stats();
  }

  /** No timer is pending while the Core is away. Writes already counted stay counted; the next write arms it again and the line then reports them. */
  private clearLatencyTimer(): void {
    if (this.latencyTimer) clearTimeout(this.latencyTimer);
    this.latencyTimer = null;
  }

  private noteConfirmed(ms: number): void {
    this.confirmLatency.record(ms);
    if (this.latencyTimer) return;
    this.latencyTimer = setTimeout(() => this.reportLatency(), LATENCY_LINE_INTERVAL_MS);
    this.latencyTimer.unref?.();
  }

  /** One line per hour: written only if the Core is connected. The timer exists only because a write armed it, so there were writes; the next write arms it again. */
  private reportLatency(): void {
    this.latencyTimer = null;
    // Counted writes are kept until a line reports them: not taken while the Core is away.
    if (!this.source.transport) return;
    const writes = this.confirmLatency.takeSince();
    console.log(`[qsys] write p95 ${scrub(this.confirmLatency.stats().p95)} ms (${scrub(writes)} writes)`);
  }

  /** The server's own release write: one control to false, as its own write-log entry. */
  private releaseRequest(lease: Lease, cause: ReleaseCause): WriteRequest {
    return {
      component: lease.component,
      control: lease.control,
      value: false,
      panelId: lease.panelId,
      device: `server (${cause})`,
      remote: lease.remote,
      final: true,
      cause,
    };
  }

  /** Write a lapsed momentary's release, through every check, as its own write-log entry. */
  private async releaseLease(lease: Lease, why: LeaseEnd): Promise<void> {
    const k = addressKey(lease);
    // Decided now: anything sent to the control from here on outranks it.
    const token: ReleaseToken = { seq: this.lastSend.get(k) ?? 0 };
    const where = `${lease.component}/${lease.control}`;
    const because = why === "lease expired" ? "no renewal from the pressing page" : "the pressing page's event stream closed";
    console.warn(`[qsys] momentary ${scrub(where)} released by the server: ${scrub(because)}`);
    const result = await this.run(this.releaseRequest(lease, why), token, null);
    if (result === SUPERSEDED) {
      console.log(`[qsys] the server's release of ${scrub(where)} was not sent: another write to it came first`);
      return;
    }
    if (result.ok) return;
    if (result.reason === "offline" || result.reason === "core-error") {
      if (!this.stillOurs(k, token)) {
        console.log(`[qsys] the server's release of ${scrub(where)} failed (${scrub(result.reason)}), and another write to it has been sent since; nothing is owed`);
        return;
      }
      console.warn(`[qsys] the server's release of ${scrub(where)} could not be sent (${scrub(result.reason)}); it is owed, and goes once writes are possible again, if the Core still reports it on`);
      this.owe({ lease, token, attempts: 0, settling: false, retry: null });
      return;
    }
    console.warn(`[qsys] the server's release of ${scrub(where)} was refused (${scrub(result.reason)}); it may still be on at the Core`);
  }

  /** Nothing has been sent to the control since the release was decided (or since it sent itself). */
  private stillOurs(k: string, token: ReleaseToken): boolean {
    return (this.lastSend.get(k) ?? 0) === token.seq;
  }

  /**
   * Keep a release owed. If writes are possible now (the Core refused it, its send
   * was cut off, or readiness came back while its refusal was being logged) it is
   * tried again shortly; otherwise it waits for readiness to come back (onReady).
   */
  private owe(o: Owed): void {
    const k = addressKey(o.lease);
    this.owed.set(k, o);
    if (this.watch.ready()) this.retryLater(k, o);
  }

  private retryLater(k: string, o: Owed): void {
    if (o.retry) clearTimeout(o.retry);
    const wait = OWED_RETRY_MS * 2 ** Math.max(0, o.attempts - 1);
    o.retry = setTimeout(() => {
      o.retry = null;
      if (this.owed.get(k) === o) void this.settle(k);
    }, wait);
  }

  /** Drop an owed release, saying why. */
  private drop(k: string, o: Owed, why: string): void {
    if (this.owed.get(k) !== o) return;
    if (o.retry) clearTimeout(o.retry);
    this.owed.delete(k);
    const where = `${o.lease.component}/${o.lease.control}`;
    console.warn(`[qsys] owed release of ${scrub(where)} dropped: ${scrub(why)}; it may still be on at the Core`);
  }

  /** A try that did not settle it: try again (shortly, if writes are possible), or give up after OWED_MAX_ATTEMPTS. */
  private failedTry(k: string, o: Owed, why: string): void {
    o.attempts++;
    if (o.attempts >= OWED_MAX_ATTEMPTS) {
      this.drop(k, o, `${why}, ${OWED_MAX_ATTEMPTS} times`);
      return;
    }
    const where = `${o.lease.component}/${o.lease.control}`;
    console.warn(`[qsys] owed release of ${scrub(where)} not settled: ${scrub(why)}; trying again`);
    if (this.watch.ready()) this.retryLater(k, o);
  }

  /**
   * The Core went away (or is being re-read) while an owed release was being
   * settled. Not a failed try: a Core that drops again and again must not use up
   * a release's tries and leave the control on. It stays owed and waits for
   * readiness (onReady), or is tried again shortly if readiness is already back.
   */
  private waitForCore(k: string, o: Owed): void {
    if (this.owed.get(k) === o && this.watch.ready()) this.retryLater(k, o);
  }

  /** Writes are possible again: settle each owed release. */
  async sendOwed(): Promise<void> {
    for (const k of [...this.owed.keys()]) await this.settle(k);
  }

  /** Read the control, and send its owed release only if the Core still reports it on. */
  private async settle(k: string): Promise<void> {
    const o = this.owed.get(k);
    if (!o || o.settling) return;
    if (o.retry) clearTimeout(o.retry);
    o.retry = null;
    const where = `${o.lease.component}/${o.lease.control}`;
    const catalog = this.source.getCatalog();
    // Not writable yet: onReady brings it back here.
    if (!this.watch.ready() || !catalog) return;
    if (o.lease.core !== this.source.core) return this.drop(k, o, "the Core it was owed to is no longer the one configured");
    if (o.lease.designCode !== catalog.designCode) return this.drop(k, o, "the Core's design has changed since it was pressed");
    if (!findControl(catalog, o.lease.component, o.lease.control)) return this.drop(k, o, "the control is not in the Core's design");
    o.settling = true;
    try {
      if (!(await qsysAllowlist.lookup(o.lease.component, o.lease.control))) return this.drop(k, o, "the control is no longer on the allowlist");
      let on: boolean;
      try {
        on = await this.isOn(o.lease);
      } catch (err) {
        if (this.owed.get(k) !== o) return;
        // The connection went away under the read: not a failed try (see waitForCore).
        if (!this.source.transport) return this.waitForCore(k, o);
        this.failedTry(k, o, `could not read it (${errorMessage(err)})`);
        return;
      }
      // Another write to the control while it was read settles it: nothing is owed.
      if (this.owed.get(k) !== o) return;
      if (!on) {
        this.owed.delete(k);
        console.log(`[qsys] owed release of ${scrub(where)} not sent: the Core reports it off`);
        return;
      }
      console.warn(`[qsys] sending the owed release of ${scrub(where)}: the Core still reports it on`);
      const result = await this.run(this.releaseRequest(o.lease, "lease owed"), o.token, o);
      if (result === SUPERSEDED) {
        console.log(`[qsys] owed release of ${scrub(where)} not sent: another write to it came first`);
        return;
      }
      if (result.ok) return;
      if (result.reason === "offline" || result.reason === "core-error") {
        // Re-owed only if nothing else has been sent to it since its own try.
        if (!this.stillOurs(k, o.token)) return;
        this.owed.set(k, o);
        if (result.reason === "offline") return this.waitForCore(k, o);
        this.failedTry(k, o, `the send failed (${result.reason})`);
        return;
      }
      this.drop(k, o, `the write was refused (${result.reason})`);
    } finally {
      o.settling = false;
    }
  }

  /** Whether the Core reports the control on: from the watch's re-read values, else asked directly. */
  private async isOn(a: Lease): Promise<boolean> {
    const watched = this.watch.current([a]).get(addressKey(a));
    const value = watched
      ? watched.Value
      : await (async () => {
          const t = this.source.transport;
          if (!t) throw new Error("not connected");
          const reply = (await t.send("Component.GetControls", { Name: a.component })) as { Controls?: { Name?: unknown; Value?: unknown }[] } | null;
          const c = reply?.Controls?.find((x) => x?.Name === a.control);
          if (!c) throw new Error("the Core did not report it");
          return c.Value;
        })();
    return value === true || value === 1;
  }

  /** Whether a release is owed on the address; for tests and diagnostics. */
  owes(a: { component: string; control: string }): boolean {
    return this.owed.has(addressKey(a));
  }

  private connectionKind(t: QrcTransport | null): string {
    if (!t) return "none";
    let id = this.connections.get(t);
    if (id === undefined) this.connections.set(t, (id = this.nextConnection++));
    return `connection ${id}`;
  }

  /**
   * The value `address` held when this gesture started. The first write of a
   * gesture (no open one for the key, or one older than GESTURE_TIMEOUT_MS) reads
   * it from the watch; a mid-gesture write keeps it; the last write takes it and
   * closes the gesture. A refused mid-gesture write leaves it to expire.
   */
  private gestureFrom(key: string, final: boolean, read: () => unknown): unknown {
    const t = this.now();
    const open = this.gestures.get(key);
    const gesture = open && t - open.at < GESTURE_TIMEOUT_MS ? open : { from: read(), at: t };
    this.gestures.delete(key);
    if (!final) {
      gesture.at = t;
      if (this.gestures.size >= MAX_GESTURES) this.gestures.delete(this.gestures.keys().next().value!);
      // Re-inserted, so the map stays in order of last use.
      this.gestures.set(key, gesture);
    }
    return gesture.from;
  }

  /** Write one control from a request: checked, sent, logged. */
  write(req: WriteRequest): Promise<WriteResult> {
    return this.run(req, null, null);
  }

  /**
   * The write itself. `release` makes it a server release that goes only if no
   * other write has been sent to the control since it was decided (SUPERSEDED,
   * nothing sent, otherwise); `owed` is the owed entry it settles, which must
   * still be in place.
   */
  private run(req: WriteRequest, release: null, owed: null): Promise<WriteResult>;
  private run(req: WriteRequest, release: ReleaseToken, owed: Owed | null): Promise<WriteResult | typeof SUPERSEDED>;
  private async run(req: WriteRequest, release: ReleaseToken | null, owed: Owed | null): Promise<WriteResult | typeof SUPERSEDED> {
    const { component, control } = req;
    let from: unknown = null;
    let to: unknown = loggable(req.value);
    const final = req.final !== false;
    const finish = async (result: WriteResult, logAs: string): Promise<WriteResult> => {
      if (result.ok && !final) return result;
      await qsysWriteLog.add({
        at: this.now(),
        panelId: req.panelId,
        device: req.device,
        remote: req.remote,
        component: isAddressPart(component) ? component : "",
        control: isAddressPart(control) ? control : "",
        from,
        to,
        result: logAs,
        ...(req.cause ? { cause: req.cause } : {}),
      });
      return result;
    };
    /** `detail` goes to /log only; the caller gets `message`. */
    const refuse = (reason: WriteRefusal, message: string, detail = message): Promise<WriteResult> => {
      const line = PRE_SEND_REFUSALS.has(reason)
        ? this.refusals.fail(reason, reason === "offline" ? this.connectionKind(this.source.transport) : req.remote, this.now())
        : { log: true, note: "" };
      if (line.log) console.warn(`[qsys] write refused (${scrub(reason)}): ${scrub(detail)}${scrub(line.note)}`);
      return finish({ ok: false, reason, message }, reason);
    };

    if (!isAddressPart(component) || !isAddressPart(control)) return refuse("not-allowed", "that is not a control address");
    const where = `${component}/${control}`;
    // The one await before the send. Everything after it, through the send, is synchronous.
    const [entry, views] = await Promise.all([
      qsysAllowlist.lookup(component, control),
      // What the panel holds: read only for a write from a panel, or one asking for a
      // lease. Cached by the store. A failed read is answered below where it matters,
      // never a rejection here.
      req.lease || req.panelId !== null ? this.loadViews().catch((err: unknown) => new Error(errorMessage(err))) : Promise.resolve([] as View[]),
    ]);
    if (!entry) return refuse("not-allowed", `${where} is not on the allowlist`);

    // ready() is the one answer to "may anything be written now" (it is false with
    // no transport); `t` is read for the send, in the same synchronous stretch.
    const t = this.source.transport;
    const catalog = this.source.getCatalog();
    if (!this.watch.ready() || !t || !catalog) {
      return refuse("offline", `the Core is not connected, or its current values have not been read since it reconnected; ${where} was not written`);
    }
    // Readiness is back: the next offline refusal starts a new episode and is logged.
    this.refusals.forget("offline");
    const c = findControl(catalog, component, control);
    if (!c) return refuse("not-in-design", `${where} is not in the Core's design`);
    const address = { component, control };
    const k = addressKey(address);
    // A control that lists its choices is held to them only for a selector on the
    // panel (a mute on a Boolean that also lists choices writes true and false). If
    // the views cannot be read to say, the choices hold, the stricter rule, except
    // on a Boolean, which stays true or false (a momentary's release among them).
    const choices = choicesOf(c);
    const viaChoices = choices !== null && (views instanceof Error ? kindOf(c) !== "boolean" : panelHasSelectorOn(views, req.panelId, address));
    const unwritable = unwritableReason(c, entry, viaChoices);
    if (unwritable) return refuse(unwritable, UNWRITABLE_MESSAGE[unwritable](where));
    const kind = viaChoices ? choiceKind(choices) : KINDS[kindOf(c)];
    // A numeric control has a range here (unwritableReason); the others ignore it.
    const checked = kind.check(req.value, entry.min ?? 0, entry.max ?? 0, where);
    if (!checked.ok) return refuse(checked.reason, checked.message);
    // A press that asks for a lease turns a Boolean on: it goes only with the lease
    // that turns it off again if the page goes away. On with nothing to release it
    // is the one outcome a momentary must not have. (A trigger fires and holds no
    // state, so it needs none.)
    const takesLease = !!req.lease && checked.send === true;
    if (takesLease) {
      if (views instanceof Error) {
        return refuse(
          "no-lease",
          `${where} was not pressed: the server could not read the saved views to hold its release`,
          `${where} was not pressed: the saved views could not be read to tell whether panel ${req.panelId ?? "(none)"} has a momentary on it (${views.message})`,
        );
      }
      if (!panelHasMomentary(views, req.panelId, address)) {
        return refuse("no-lease", `${where} was not pressed: panel ${req.panelId ?? "(none)"} has no momentary button on it, so the server will not hold it on`);
      }
    }
    // A server release goes only if nothing has been sent to the control since it was
    // decided, and an owed one only while it is still owed: checked here, next to the
    // send, so a fresh press that got here first is never turned off by it.
    if (release && (!this.stillOurs(k, release) || (owed && this.owed.get(k) !== owed))) return SUPERSEDED;
    from = this.gestureFrom(`${req.remote}\u0000${req.panelId ?? ""}\u0000${k}`, final, () => this.watch.current([address]).get(k)?.Value ?? null);
    to = checked.send;
    // Any write to a held momentary ends its lease, and any release owed on it: the
    // page's release, or someone's (an owed release's own send claims its entry; it
    // is put back if the send fails). A press that takes a lease starts a new one
    // once it lands (below).
    this.leases.cancel(address);
    if (this.owed.get(k)?.retry) clearTimeout(this.owed.get(k)!.retry!);
    this.owed.delete(k);
    const seq = ++this.sendSeq;
    this.lastSend.set(k, seq);
    if (release) release.seq = seq;
    const designCode = catalog.designCode;
    const core = this.source.core;
    // The connection the press was made on, taken now: only that connection closing
    // releases it, never a late close of one this page has already replaced.
    const connection = takesLease && req.cid ? connectionOf(req.cid) : null;
    // A press takes its lease when it lands, unless another write was sent to the
    // control after it: that write ended the press, and a lease now would release it.
    const lease = (): void => {
      if (takesLease && this.lastSend.get(k) === seq) {
        this.leases.hold({ component, control, cid: req.cid ?? null, connection, panelId: req.panelId, device: req.device, remote: req.remote, designCode, core });
      }
    };
    const sentAt = performance.now();
    const sending = t.send("Component.Set", { Name: component, Controls: [{ Name: control, Value: checked.send }], ResponseValues: true });

    let reply: unknown;
    try {
      reply = await sending;
      this.noteConfirmed(performance.now() - sentAt);
    } catch (err) {
      if (err instanceof QrcError) return refuse("core-error", `the Core refused the write to ${where}: ${err.message}`);
      // It may have landed: a momentary press takes its lease all the same, so it is released.
      lease();
      // The reason (a socket error can name the Core's address) goes to /log, not to the page.
      const message = `the connection to the Core dropped during the write to ${where}, so it may or may not have landed`;
      return refuse("core-error", message, `${message}: ${errorMessage(err)}`);
    }
    const back = readBack(reply, control);
    if (!back || !("Value" in back)) {
      lease();
      return refuse("core-error", `the Core did not report ${where} after the write; it may have landed`);
    }

    // A write landed: a run of pre-send refusals that has been quiet for a minute is over.
    for (const reason of PRE_SEND_REFUSALS) if (reason !== "offline") this.refusals.ok(reason, this.now());
    if (checked.clamped && final) console.log(`[qsys] write to ${scrub(where)} clamped from ${scrub(req.value)} to ${scrub(checked.send)}`);
    const matched = kind.same(checked.send, back.Value);
    if (!matched && final) console.warn(`[qsys] read-back mismatch on ${scrub(where)}: sent ${scrub(checked.send)}, the Core holds ${scrub(back.Value)}`);
    const result: WriteResult = {
      ok: true,
      value: back.Value,
      string: typeof back.String === "string" ? back.String : String(back.Value),
      clamped: checked.clamped,
    };
    if (typeof back.Position === "number") result.position = back.Position;
    lease();
    return finish(result, !matched ? "mismatch" : checked.clamped ? "clamped" : "ok");
  }
}

export const qsysWriter = new QsysWriter(qsysService, qsysWatch);
// A pressing page's connection closing releases the momentaries pressed on it.
addStreamClosedListener((cid, connection) => qsysWriter.leases.streamClosed(cid, connection));

/** Write one control, checked against the allowlist and the connection. See QsysWriter. */
export function writeControl(req: WriteRequest): Promise<WriteResult> {
  return qsysWriter.write(req);
}
