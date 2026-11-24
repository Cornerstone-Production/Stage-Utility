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

import { errorMessage } from "../errors.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import { addressKey } from "../../types/qsys.js";
import { QrcError, type QrcTransport } from "./qrc-client.js";
import type { QrcControl } from "./qrc-types.js";
import { type AllowEntry, isAddressPart, qsysAllowlist } from "./qsys-allowlist-store.js";
import { qsysService, type QsysCatalog } from "./qsys-service.js";
import { qsysWatch } from "./qsys-watch.js";
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

type Kind = "boolean" | "trigger" | "text" | "number";

/**
 * Which rules a control's writes follow. Fails closed: anything not positively a
 * boolean, trigger or text control is numeric, so it is range-checked. The Type
 * strings the Core reports are on the spec's "verify in Emulate" list; the
 * value's own type backs them up.
 */
export function kindOf(c: QrcControl): Kind {
  const type = String(c.Type ?? "");
  if (/^bool/i.test(type) || typeof c.Value === "boolean") return "boolean";
  if (/^trigger/i.test(type)) return "trigger";
  if (/^(text|string)$/i.test(type)) return "text";
  return "number";
}

/**
 * Why `c` cannot be written under `entry` whatever the value, or null when it
 * can: the Core reports it read-only, or it is numeric and the entry sets no
 * range. The one rule for "is this writable"; the writer refuses on it before
 * sending, and anything that asks the same question asks here.
 */
export function unwritableReason(c: QrcControl, entry: Pick<AllowEntry, "min" | "max">): "read-only" | "no-range" | null {
  if (/^read$/i.test(String(c.Direction ?? "").trim())) return "read-only";
  if (kindOf(c) === "number" && (entry.min === null || entry.max === null)) return "no-range";
  return null;
}

export function isWritable(c: QrcControl, entry: Pick<AllowEntry, "min" | "max">): boolean {
  return unwritableReason(c, entry) === null;
}

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

  constructor(
    private readonly source: WriteSource,
    private readonly watch: WriteReadiness,
    private readonly now: () => number = Date.now,
  ) {}

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
    const entry = await qsysAllowlist.lookup(component, control);
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
    const sending = t.send("Component.Set", { Name: component, Controls: [{ Name: control, Value: checked.send }], ResponseValues: true });

    let reply: unknown;
    try {
      reply = await sending;
    } catch (err) {
      if (err instanceof QrcError) return refuse("core-error", `the Core refused the write to ${where}: ${err.message}`);
      // The reason (a socket error can name the Core's address) goes to /log, not to the page.
      const message = `the connection to the Core dropped during the write to ${where}, so it may or may not have landed`;
      return refuse("core-error", message, `${message}: ${errorMessage(err)}`);
    }
    const controls = (reply as { Controls?: unknown } | null)?.Controls;
    const back = Array.isArray(controls)
      ? (controls as { Name?: unknown; Value?: unknown; String?: unknown; Position?: unknown }[]).find((x) => x?.Name === control)
      : undefined;
    if (!back || !("Value" in back)) return refuse("core-error", `the Core did not report ${where} after the write; it may have landed`);

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
    return finish(result, !matched ? "mismatch" : checked.clamped ? "clamped" : "ok");
  }
}

export const qsysWriter = new QsysWriter(qsysService, qsysWatch);

/** Write one control, checked against the allowlist and the connection. See QsysWriter. */
export function writeControl(req: WriteRequest): Promise<WriteResult> {
  return qsysWriter.write(req);
}
