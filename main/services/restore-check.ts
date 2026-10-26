// restore-check.ts — what a config store accepts from a restore.
//
// A restore writes a store's file whole, and any device on the LAN can post
// one. So every "config" store declares a check in its constructor (DataStore's
// `restoreCheck`; the type checker will not take a config store without one),
// and config-snapshot runs every file of a restore through its check before it
// pauses, clears or writes anything. One refusal refuses the whole restore.
//
// A check applies the rules the store's save path applies, by calling the same
// functions where the save has one, and returns the value to write: the input,
// or the input normalised (trimmed, clamped, filtered) the way a save would
// normalise it. Where a save coerces a bad value rather than refusing it, the
// check coerces it too. Shape checks a save gets from its request parsing
// (this field is a list, that one text) are applied as refusals. The one rule
// deliberately stricter than any save is config-snapshot's cap on how many
// files and images a bundle may list. Checks may be async, so one can import
// its rules lazily where a static import would be a cycle.

import { errorMessage } from "./errors.js";
import { isRecord } from "./is-record.js";
import { isSafeKey } from "./safe-key.js";

export type RestoreResult = { ok: true; value: unknown } | { ok: false; reason: string };
export type RestoreCheck = (raw: unknown) => RestoreResult | Promise<RestoreResult>;

/**
 * A check written as a function that returns the value to write and throws to
 * refuse. Any throw is a refusal and its message the reason: the throw is
 * returned to the caller, not swallowed.
 */
export function checked(fn: (raw: unknown) => unknown): RestoreCheck {
  return async (raw) => {
    try {
      return { ok: true, value: await fn(raw) };
    } catch (err) {
      return { ok: false, reason: errorMessage(err) };
    }
  };
}

export function refuse(reason: string): never {
  throw new Error(reason);
}

type TypeName = "string" | "boolean" | "number";

/** How a refusal names a type. */
export function typeName(type: TypeName): string {
  return type === "string" ? "text" : type === "boolean" ? "true or false" : "a number";
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

/** Refuse `v` unless it is a value of `type`. */
export function required(v: unknown, type: TypeName, what: string): void {
  if (typeof v !== type) refuse(`${what} must be ${typeName(type)}`);
}

/** Refuse `v` unless it is absent or a value of `type`. */
export function optional(v: unknown, type: TypeName, what: string): void {
  if (v !== undefined) required(v, type, what);
}

/** Refuse `v` unless it is absent, null or text. */
export function textOrNull(v: unknown, what: string): void {
  if (v !== undefined && v !== null && typeof v !== "string") refuse(`${what} must be text or null`);
}

/** Refuse `v` unless it is a list of text. */
export function textList(v: unknown, what: string): string[] {
  const list = asArray(v, what);
  if (!list.every((s) => typeof s === "string")) refuse(`${what} must be a list of text`);
  return list as string[];
}

/** Refuse an object keyed by a name that reaches the prototype chain. */
export function safeKeys(obj: Record<string, unknown>, what: string): void {
  for (const k of Object.keys(obj)) if (!isSafeKey(k)) refuse(`${what} has a key that is not allowed ("${k}")`);
}

/** Refuse a list whose entries share an id. */
export function uniqueIds(entries: readonly Record<string, unknown>[], what: string): void {
  const seen = new Set<unknown>();
  for (const e of entries) {
    if (seen.has(e.id)) refuse(`${what} lists the id "${String(e.id).slice(0, 60)}" more than once`);
    seen.add(e.id);
  }
}

/** A list of entries, each an object with a text `id` and `name`, the shape
 *  most stores of the operator's named things share. */
export function namedEntries(raw: unknown, what: string): Record<string, unknown>[] {
  return asArray(raw, what).map((entry, i) => {
    const e = asObject(entry, `${what} entry ${i + 1}`);
    required(e.id, "string", `${what} entry ${i + 1}'s id`);
    required(e.name, "string", `${what} entry ${i + 1}'s name`);
    return e;
  });
}

/** Targets as the OSC and wireless routes keep them: a text name, a boolean
 *  `enabled`, an object `config`. */
export function targetEntries(raw: unknown, what: string): Record<string, unknown>[] {
  return namedEntries(raw, what).map((t, i) => {
    optional(t.enabled, "boolean", `${what} entry ${i + 1}'s enabled`);
    asObject(t.config ?? {}, `${what} entry ${i + 1}'s config`);
    return t;
  });
}
