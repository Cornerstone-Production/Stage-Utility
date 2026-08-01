// safe-key.ts — keys that must never be used to index a persisted map.
//
// Several stores key a map by something that arrives in a request: a display id,
// a view id, a service type id, an icon name. The shape is always the same —
//
//   if (!map[k]) map[k] = {};
//   map[k][k2] = value;
//
// — and it is unsafe for exactly three keys. `map["__proto__"]` is truthy on any
// object literal, so the guard passes, and the write then lands on
// Object.prototype rather than on the map. Every object in the process gains the
// property, and because the map is persisted, it comes back on restart.
//
// Reachable from the LAN today: POST /api/slots takes body.displayId as an
// arbitrary string, and it reaches slotsStore.setSlots unchanged.
//
// Rejecting is the right response rather than sanitising: no legitimate display,
// view or service type is called "__proto__", so a request using one is not a
// request worth guessing the intent of.

/** Keys that reach the prototype chain instead of the object. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** Is this key safe to use as a map index? */
export function isSafeKey(key: string): boolean {
  return !FORBIDDEN.has(key);
}

/**
 * Throw if `key` would write through to the prototype chain.
 *
 * `what` names the field in the error, so the log says which input was refused
 * rather than only that something was.
 */
export function assertSafeKey(key: string, what: string): void {
  if (!isSafeKey(key)) {
    throw new Error(`${what}: "${key}" is not an allowed identifier`);
  }
}

/**
 * A copy of `obj` with any forbidden own keys dropped.
 *
 * For data arriving from disk or from an import bundle, where throwing would
 * make a whole file unreadable over one bad key.
 */
export function withoutUnsafeKeys<T extends object>(obj: T): T {
  let clean: Record<string, unknown> | null = null;
  for (const k of Object.keys(obj)) {
    if (isSafeKey(k)) continue;
    clean ??= { ...(obj as Record<string, unknown>) };
    delete clean[k];
  }
  return (clean ?? obj) as T;
}
