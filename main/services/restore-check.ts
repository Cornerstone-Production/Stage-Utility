// restore-check.ts — what a config store accepts from a restore.
//
// A restore writes a store's file whole. Without a check it could put there what
// the store's own settings routes would refuse — a feed address of
// `file:/etc/passwd`, a cue name that is not a URL — and any device on the LAN
// can post one. So every "config" store declares a check in its constructor
// (DataStore's `restoreCheck`; the type checker will not take a config store
// without one), and config-snapshot runs every file of a restore through its
// check before writing any of them. One refusal refuses the whole restore.
//
// A check applies the rules the store's save path applies, and no others. It
// returns the value to write — usually the input, sometimes the input
// normalised the way a save would normalise it — or the reason it refused,
// naming the field. Checks may be async, so one can import its rules lazily
// where a static import would be a cycle.

import { errorMessage } from "./errors.js";
import { isRecord } from "./is-record.js";
import { isSafeKey } from "./safe-key.js";

export type RestoreResult = { ok: true; value: unknown } | { ok: false; reason: string };
export type RestoreCheck = (raw: unknown) => RestoreResult | Promise<RestoreResult>;

/** Thrown by a rule inside `checked`; its message is the refusal. */
export class RestoreRefused extends Error {}

/**
 * A check written as a function that returns the value to write and throws to
 * refuse. Any throw is a refusal and its message the reason: the throw is
 * returned to the caller, not swallowed.
 */
export function checked(fn: (raw: unknown) => unknown | Promise<unknown>): RestoreCheck {
  return async (raw) => {
    try {
      return { ok: true, value: await fn(raw) };
    } catch (err) {
      return { ok: false, reason: errorMessage(err) };
    }
  };
}

export function refuse(reason: string): never {
  throw new RestoreRefused(reason);
}

/** A JSON object, or a refusal naming `what`. */
export function asObject(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) refuse(`${what} must be an object`);
  return v;
}

/** A JSON array, or a refusal naming `what`. */
export function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) refuse(`${what} must be a list`);
  return v;
}

/** Refuse `v` unless it is absent or a value of `type`. */
export function optional(v: unknown, type: "string" | "boolean" | "number", what: string): void {
  if (v !== undefined && typeof v !== type) refuse(`${what} must be a ${type === "string" ? "text value" : type}`);
}

/** Refuse `v` unless it is a value of `type`. */
export function required(v: unknown, type: "string" | "boolean" | "number", what: string): void {
  if (typeof v !== type) refuse(`${what} must be a ${type === "string" ? "text value" : type}`);
}

/** Refuse an object keyed by a name that reaches the prototype chain. */
export function safeKeys(obj: Record<string, unknown>, what: string): void {
  for (const k of Object.keys(obj)) if (!isSafeKey(k)) refuse(`${what} has a key that is not allowed ("${k}")`);
}

/** A list of entries, each an object with a string `id` and `name`, the
 *  shape most stores of the operator's named things share. */
export function namedEntries(raw: unknown, what: string): Record<string, unknown>[] {
  return asArray(raw, what).map((entry, i) => {
    const e = asObject(entry, `${what} entry ${i + 1}`);
    required(e.id, "string", `${what} entry ${i + 1}'s id`);
    required(e.name, "string", `${what} entry ${i + 1}'s name`);
    return e;
  });
}

/**
 * A list of targets as the target routes keep them: an id, a name that is
 * text, `enabled` a boolean and `config` an object. The routes check those
 * types and no more; neither does this.
 */
export function targetEntries(raw: unknown, what: string): Record<string, unknown>[] {
  return namedEntries(raw, what).map((t, i) => {
    optional(t.enabled, "boolean", `${what} entry ${i + 1}'s enabled`);
    asObject(t.config ?? {}, `${what} entry ${i + 1}'s config`);
    return t;
  });
}
