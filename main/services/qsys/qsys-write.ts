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

import { addStreamClosedListener } from "../broadcaster.js";
import { viewsStore } from "../views-store.js";
import { errorMessage } from "../errors.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import { addressKey, isWritable, kindOf, panelHasMomentary, type QsysControlKind, unwritableReason } from "../../types/qsys.js";

// The rules live in types/qsys.ts so the editor shares them; re-exported for the server.
export { isWritable, kindOf, unwritableReason };
import { QrcError, type QrcTransport } from "./qrc-client.js";
import type { QrcControl } from "./qrc-types.js";
import { isAddressPart, qsysAllowlist } from "./qsys-allowlist-store.js";
import { qsysService, type QsysCatalog } from "./qsys-service.js";
import { qsysWatch } from "./qsys-watch.js";
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
   * the renewals stop or `cid`'s event stream closes (qsys-leases.ts).
   */
  lease?: boolean;
  /** The pressing page's event-stream client id, so its stream closing ends the lease. */
  cid?: string | null;
  /** Why the server wrote this itself (a lease ending, or a release owed); in the write log. */
  cause?: ReleaseCause;
}

export type WriteRefusal = "not-allowed" | "not-in-design" | "read-only" | "no-range" | "offline" | "bad-value" | "core-error";

export type WriteResult =
  | { ok: true; value: unknown; string: string; position?: number; clamped: boolean }
  | { ok: false; reason: WriteRefusal; message: string };

/** What the writer needs from the connection. QsysService satisfies it. */
export interface WriteSource {
  readonly transport: QrcTransport | null;
  getCatalog(): QsysCatalog | null;
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
    // QRC fires a trigger on any Set; 1 is what the reference shows.
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

/** A value fit for the log: what the request carried, bounded. */
function loggable(v: unknown): unknown {
  if (typeof v === "string") return v.slice(0, MAX_TEXT);
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  return null;
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
   * Releases the server could not send (the Core away or not yet re-read), by
   * address. A fail-safe to off, not a replay: when writes are possible again the
   * control is read, and the release goes only if the Core still reports it on.
   * Any other write to the control in the meantime cancels it.
   */
  private readonly owed = new Map<string, Lease>();
  /**
   * Whether `panelId` has a momentary button on the address: only then does a
   * press take a lease (main/types/qsys.ts panelHasMomentary). Read from the
   * saved views; a stand-in for tests.
   */
  momentaryCheck: (panelId: string | null, a: { component: string; control: string }) => Promise<boolean> = async (panelId, a) =>
    panelHasMomentary(await viewsStore.load(), panelId, a);
  /** Lease asks already logged as refused, so a client repeating one is one line. */
  private readonly leaseRefusals = new Set<string>();

  constructor(
    private readonly source: WriteSource,
    private readonly watch: WriteReadiness,
    private readonly now: () => number = Date.now,
  ) {
    watch.onReady?.(() => void this.sendOwed());
  }

  /** Write a lapsed momentary's release, through every check, as its own write-log entry. */
  private async releaseLease(lease: Lease, why: LeaseEnd): Promise<void> {
    const where = `${lease.component}/${lease.control}`;
    const because = why === "lease expired" ? "no renewal from the pressing page" : "the pressing page's event stream closed";
    console.warn(`[qsys] momentary ${scrub(where)} released by the server: ${scrub(because)}`);
    const result = await this.write({
      component: lease.component,
      control: lease.control,
      value: false,
      panelId: lease.panelId,
      device: `server (${why})`,
      remote: lease.remote,
      final: true,
      cause: why,
    });
    if (result.ok) return;
    if (result.reason === "offline" || result.reason === "core-error") {
      // The Core is away (or the send may not have landed): owed, until writes are possible again.
      this.owed.set(addressKey(lease), lease);
      console.warn(`[qsys] the server's release of ${scrub(where)} could not be sent (${scrub(result.reason)}); it is owed, and goes once the Core's values have been read again, if the Core still reports it on`);
      return;
    }
    console.warn(`[qsys] the server's release of ${scrub(where)} was refused (${scrub(result.reason)}); it may still be on at the Core`);
  }

  /** Writes are possible again: send each owed release whose control the Core still reports on. */
  async sendOwed(): Promise<void> {
    for (const [k, lease] of [...this.owed]) {
      const where = `${lease.component}/${lease.control}`;
      let on: boolean;
      try {
        on = await this.isOn(lease);
      } catch (err) {
        // Could not read it: it stays owed for the next time writes open.
        console.warn(`[qsys] could not read ${scrub(where)} to settle its owed release: ${scrub(errorMessage(err))}`);
        continue;
      }
      // Another write to the control while it was read settles it: nothing is owed.
      if (this.owed.get(k) !== lease) continue;
      this.owed.delete(k);
      if (!on) {
        console.log(`[qsys] owed release of ${scrub(where)} not sent: the Core reports it off`);
        continue;
      }
      console.warn(`[qsys] sending the owed release of ${scrub(where)}: the Core still reports it on`);
      const result = await this.write({
        component: lease.component,
        control: lease.control,
        value: false,
        panelId: lease.panelId,
        device: "server (lease owed)",
        remote: lease.remote,
        final: true,
        cause: "lease owed",
      });
      if (!result.ok && (result.reason === "offline" || result.reason === "core-error")) {
        if (!this.owed.has(k)) this.owed.set(k, lease);
      } else if (!result.ok) {
        console.warn(`[qsys] the owed release of ${scrub(where)} was refused (${scrub(result.reason)}); it may still be on at the Core`);
      }
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

  async write(req: WriteRequest): Promise<WriteResult> {
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
    const [entry, momentary] = await Promise.all([
      qsysAllowlist.lookup(component, control),
      req.lease ? this.momentaryCheck(req.panelId, { component, control }) : Promise.resolve(false),
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
    const unwritable = unwritableReason(c, entry);
    if (unwritable) return refuse(unwritable, UNWRITABLE_MESSAGE[unwritable](where));
    const kind = KINDS[kindOf(c)];
    // A numeric control has a range here (unwritableReason); the others ignore it.
    const checked = kind.check(req.value, entry.min ?? 0, entry.max ?? 0, where);
    if (!checked.ok) return refuse(checked.reason, checked.message);
    const address = { component, control };
    from = this.gestureFrom(`${req.remote}\u0000${req.panelId ?? ""}\u0000${addressKey(address)}`, final, () => this.watch.current([address]).get(addressKey(address))?.Value ?? null);
    to = checked.send;
    // Any write to a held momentary ends its lease, and any release owed on it: the
    // page's release, or someone's. A press that takes a lease starts a new one once
    // it lands (below).
    this.leases.cancel(address);
    if (!req.cause) this.owed.delete(addressKey(address));
    // A lease only for a momentary button on the asking panel, on a Boolean.
    const takesLease = !!req.lease && checked.send === true && momentary;
    if (req.lease && !takesLease) {
      const k = `${req.panelId ?? ""}\u0000${addressKey(address)}`;
      if (!this.leaseRefusals.has(k)) {
        if (this.leaseRefusals.size >= MAX_GESTURES) this.leaseRefusals.clear();
        this.leaseRefusals.add(k);
        console.warn(`[qsys] lease asked for ${scrub(where)} by panel ${scrub(req.panelId ?? "(none)")}, which has no momentary button on it; written without one`);
      }
    }
    const lease = (): void => {
      if (takesLease) this.leases.hold({ component, control, cid: req.cid ?? null, panelId: req.panelId, device: req.device, remote: req.remote });
    };
    const sending = t.send("Component.Set", { Name: component, Controls: [{ Name: control, Value: checked.send }], ResponseValues: true });

    let reply: unknown;
    try {
      reply = await sending;
    } catch (err) {
      if (err instanceof QrcError) return refuse("core-error", `the Core refused the write to ${where}: ${err.message}`);
      // It may have landed: a momentary press takes its lease all the same, so it is released.
      lease();
      // The reason (a socket error can name the Core's address) goes to /log, not to the page.
      const message = `the connection to the Core dropped during the write to ${where}, so it may or may not have landed`;
      return refuse("core-error", message, `${message}: ${errorMessage(err)}`);
    }
    const controls = (reply as { Controls?: unknown } | null)?.Controls;
    const back = Array.isArray(controls)
      ? (controls as { Name?: unknown; Value?: unknown; String?: unknown; Position?: unknown }[]).find((x) => x?.Name === control)
      : undefined;
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
// A pressing page's stream closing releases its momentaries.
addStreamClosedListener((cid) => qsysWriter.leases.streamClosed(cid));

/** Write one control, checked against the allowlist and the connection. See QsysWriter. */
export function writeControl(req: WriteRequest): Promise<WriteResult> {
  return qsysWriter.write(req);
}
