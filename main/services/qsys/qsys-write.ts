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
// was sent is logged. Every call, refused or not, is one write-log entry.

import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";
import { addressKey } from "../../types/qsys.js";
import { QrcError, type QrcTransport } from "./qrc-client.js";
import type { QrcControl } from "./qrc-types.js";
import { isAddressPart, qsysAllowlist } from "./qsys-allowlist-store.js";
import { qsysService, type QsysCatalog } from "./qsys-service.js";
import { qsysWatch } from "./qsys-watch.js";
import { qsysWriteLog } from "./qsys-write-log.js";

export interface WriteRequest {
  component: string;
  control: string;
  value: number | boolean | string;
  panelId: string | null;
  /** Who asked: the request's address and user agent. */
  device: string;
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

function findControl(catalog: QsysCatalog | null, component: string, control: string): QrcControl | undefined {
  return catalog?.components.find((c) => c.name === component)?.controls.find((c) => c.Name === control);
}

export class QsysWriter {
  constructor(
    private readonly source: WriteSource,
    private readonly watch: WriteReadiness,
  ) {}

  async write(req: WriteRequest): Promise<WriteResult> {
    const { component, control } = req;
    let from: unknown = null;
    let to: unknown = loggable(req.value);
    const finish = async (result: WriteResult, logAs: string): Promise<WriteResult> => {
      await qsysWriteLog.add({
        at: Date.now(),
        panelId: req.panelId,
        device: req.device,
        component: isAddressPart(component) ? component : "",
        control: isAddressPart(control) ? control : "",
        from,
        to,
        result: logAs,
      });
      return result;
    };
    const refuse = (reason: WriteRefusal, message: string): Promise<WriteResult> => {
      console.warn(`[qsys] write refused (${scrub(reason)}): ${scrub(message)}`);
      return finish({ ok: false, reason, message }, reason);
    };

    if (!isAddressPart(component) || !isAddressPart(control)) return refuse("not-allowed", "that is not a control address");
    const where = `${component}/${control}`;
    // The one await before the send. Everything after it, through the send, is synchronous.
    const entry = await qsysAllowlist.lookup(component, control);
    if (!entry) return refuse("not-allowed", `${where} is not on the allowlist`);

    const t = this.source.transport;
    if (!t || !this.watch.ready()) return refuse("offline", `the Core is not connected, or its current values have not been read since it reconnected; ${where} was not written`);
    const c = findControl(this.source.getCatalog(), component, control);
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
      return refuse("core-error", `the write to ${where} did not complete, so it may or may not have landed: ${errorMessage(err)}`);
    }
    const controls = (reply as { Controls?: unknown } | null)?.Controls;
    const back = Array.isArray(controls)
      ? (controls as { Name?: unknown; Value?: unknown; String?: unknown; Position?: unknown }[]).find((x) => x?.Name === control)
      : undefined;
    if (!back || !("Value" in back)) return refuse("core-error", `the Core did not report ${where} after the write; it may have landed`);

    if (checked.clamped) console.log(`[qsys] write to ${scrub(where)} clamped from ${scrub(req.value)} to ${scrub(checked.send)}`);
    const matched = sameValue(kind, checked.send, back.Value);
    if (!matched) console.warn(`[qsys] read-back mismatch on ${scrub(where)}: sent ${scrub(checked.send)}, the Core holds ${scrub(back.Value)}`);
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
