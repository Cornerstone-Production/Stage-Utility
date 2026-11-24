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
// is one when it is its gesture's last (`final` not false). Refusals checked
// before sending write their [qsys] line at a limited rate (RefusalLines).

import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";
import { addressKey } from "../../types/qsys.js";
import { QrcError, type QrcTransport } from "./qrc-client.js";
import type { QrcControl } from "./qrc-types.js";
import { isAddressPart, qsysAllowlist } from "./qsys-allowlist-store.js";
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

export type WriteRefusal = "not-allowed" | "no-range" | "offline" | "bad-value" | "core-error";

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
/** Distinct refusal keys remembered before the memory is reset. */
const MAX_REFUSAL_KEYS = 256;

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
function kindOf(c: QrcControl): Kind {
  const type = String(c.Type ?? "");
  if (/^bool/i.test(type) || typeof c.Value === "boolean") return "boolean";
  if (/^trigger/i.test(type)) return "trigger";
  if (/^(text|string)$/i.test(type)) return "text";
  return "number";
}

type Checked = { ok: true; send: number | boolean | string; clamped: boolean } | { ok: false; reason: WriteRefusal; message: string };

function checkValue(kind: Kind, value: unknown, min: number | null, max: number | null, where: string): Checked {
  switch (kind) {
    case "boolean":
      if (typeof value !== "boolean") return { ok: false, reason: "bad-value", message: `${where} takes true or false` };
      return { ok: true, send: value, clamped: false };
    case "trigger":
      // QRC fires a trigger on any Set; 1 is what the reference shows.
      if (value !== true && value !== 1) return { ok: false, reason: "bad-value", message: `${where} is a trigger; send true` };
      return { ok: true, send: 1, clamped: false };
    case "text":
      if (typeof value !== "string" || value.length > MAX_TEXT) return { ok: false, reason: "bad-value", message: `${where} takes text of up to ${MAX_TEXT} characters` };
      return { ok: true, send: value, clamped: false };
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "bad-value", message: `${where} takes a finite number` };
      if (min === null || max === null) return { ok: false, reason: "no-range", message: `${where} has no write range set on the allowlist` };
      const send = Math.min(max, Math.max(min, value));
      return { ok: true, send, clamped: send !== value };
    }
  }
}

function sameValue(kind: Kind, sent: number | boolean | string, got: unknown): boolean {
  switch (kind) {
    case "trigger":
      return true;
    case "boolean":
      return sent === (got === true || got === 1);
    case "number":
      return typeof got === "number" && Math.abs(got - (sent as number)) <= READBACK_TOLERANCE;
    case "text":
      return got === sent;
  }
}

/** A value fit for the log: what the request carried, bounded. */
function loggable(v: unknown): unknown {
  if (typeof v === "string") return v.slice(0, MAX_TEXT);
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  return null;
}

function findControl(catalog: QsysCatalog, component: string, control: string): QrcControl | undefined {
  return catalog.components.find((c) => c.name === component)?.controls.find((c) => c.Name === control);
}

/**
 * Refusals checked before anything is sent (offline, not-allowed, no-range,
 * bad-value) can arrive at drag rate, or from a client looping on a bad request.
 * Each kind writes its [qsys] line once, then again only when its state changes
 * (for offline: a different connection, or none) or a minute has passed, saying
 * how many it held back. A refusal from the Core itself is always written.
 */
type Gate = { state: unknown; at: number; held: number };

class RefusalLines {
  /** Offline is one connection-wide state, kept apart so no other key can evict it. */
  private offline: Gate | null = null;
  /** Per reason and remote address, oldest first; past the cap the oldest is dropped, never the lot. */
  private readonly byRemote = new Map<string, Gate>();

  constructor(private readonly now: () => number) {}

  forgetOffline(): void {
    this.offline = null;
  }

  /** Null when this line is held back; otherwise how many like it were held back since the last. */
  gateOffline(state: unknown): number | null {
    const { gate, held } = this.pass(this.offline, state);
    this.offline = gate;
    return held;
  }

  gateRemote(key: string): number | null {
    const last = this.byRemote.get(key);
    const { gate, held } = this.pass(last ?? null, undefined);
    // Re-inserted, so the map stays in order of last use.
    this.byRemote.delete(key);
    if (!last && this.byRemote.size >= MAX_REFUSAL_KEYS) this.byRemote.delete(this.byRemote.keys().next().value!);
    this.byRemote.set(key, gate);
    return held;
  }

  private pass(last: Gate | null, state: unknown): { gate: Gate; held: number | null } {
    const t = this.now();
    if (last && last.state === state && t - last.at < REFUSAL_LINE_INTERVAL_MS) {
      last.held++;
      return { gate: last, held: null };
    }
    return { gate: { state, at: t, held: 0 }, held: last?.held ?? 0 };
  }
}

export class QsysWriter {
  private readonly lines: RefusalLines;

  constructor(
    private readonly source: WriteSource,
    private readonly watch: WriteReadiness,
    private readonly now: () => number = Date.now,
  ) {
    this.lines = new RefusalLines(now);
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
      const held = !PRE_SEND_REFUSALS.has(reason)
        ? 0
        : reason === "offline"
          ? this.lines.gateOffline(this.source.transport)
          : this.lines.gateRemote(`${reason}\u0000${req.remote}`);
      if (held !== null) {
        console.warn(`[qsys] write refused (${scrub(reason)}): ${scrub(detail)}${scrub(held ? ` (${held} more like it not logged)` : "")}`);
      }
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
    this.lines.forgetOffline();
    const c = findControl(catalog, component, control);
    if (!c) return refuse("core-error", `${where} is not in the Core's design`);
    const kind = kindOf(c);
    const checked = checkValue(kind, req.value, entry.min, entry.max, where);
    if (!checked.ok) return refuse(checked.reason, checked.message);
    from = this.watch.current([{ component, control }]).get(addressKey({ component, control }))?.Value ?? null;
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

    if (checked.clamped && final) console.log(`[qsys] write to ${scrub(where)} clamped from ${scrub(req.value)} to ${scrub(checked.send)}`);
    const matched = sameValue(kind, checked.send, back.Value);
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
