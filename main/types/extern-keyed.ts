// extern-keyed.ts — a lookup table whose KEYS came from outside this process.
//
// A registry indexed by a string the process did not author — a condition id out
// of automation-rules.json, an object type out of views.json, a commandId off the
// LAN, a file extension out of a restore archive — is not protected by the
// `if (!def)` line under it. Every plain object inherits `Object.prototype`, so
// `TABLE["constructor"]`, `TABLE["__proto__"]`, `TABLE["valueOf"]` and
// `TABLE["toString"]` all answer with a TRUTHY prototype member, and the guard
// waves it through as a registered entry. `"constructor" in TABLE` is true for
// the same reason.
//
// Observed on the real modules before this existed: a rules file carrying
// `id: "constructor"` on a condition made firstFailingCondition throw
// `def.holds is not a function`, and that path runs inside a fire-and-forget
// `void this.handleBroadcast(...)` — an unhandled rejection, which on Node's
// default is the server exiting mid-service.
//
// A `Partial<Record<K, V>>` with a `?? fallback` is what makes these look
// handled. It is a type-level claim only: nothing at runtime stops the lookup
// returning `Object`, and `Object` is not nullish, so the fallback never fires.
//
// The fix is at the TABLE, not at each lookup. A table with no prototype has no
// inherited members to find, so every present and future `[]` read and `in` test
// against it is safe at once — including ones in files this change does not
// touch. Same reasoning as the `Map` in cue-states.ts and the `Object.hasOwn` in
// `isDisplayKind`; a `Map` was not used here because these tables are also
// iterated with `Object.values`/`Object.entries` from call sites a Map would
// silently answer `[]` for.
//
// Iteration, spread, `Object.keys/values/entries`, `JSON.stringify` and
// assignment all behave exactly as they did. What changes: `table.hasOwnProperty`
// and `table.toString` are gone (use `Object.hasOwn(table, k)` and
// `String(table)`), and `assert.deepStrictEqual(table, {...})` now fails on the
// prototype — compare `{ ...table }` instead.

/**
 * The same table, with no prototype behind it.
 *
 * Wrap EVERY registry looked up by a key that arrived from disk, from HTTP or
 * off the LAN. `extern-keyed.test.ts` asserts the exact set that is wrapped.
 */
export function externKeyed<T extends object>(entries: T): T {
  // Object.assign copies own enumerable properties only, so nothing from the
  // literal's own prototype comes across either.
  return Object.assign(Object.create(null) as T, entries);
}
