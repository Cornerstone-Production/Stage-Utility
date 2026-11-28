// canonical-json.ts — JSON that does not depend on the order a producer emitted
// its fields in, so two copies of a record compare equal when they say the same.
//
// Pure and import-free: the renderer imports it for its unsaved-changes check, the
// server for diffing a board or an archive. Three copies existed (a replacer that
// dropped undefined, a hand recursion that printed it as null, a copy-and-sort
// that dropped it) and disagreed on exactly that.

/** JSON with every object's keys sorted at every depth and undefined properties
 *  left out, as JSON.stringify already leaves them out of a plain object. */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }) ?? "null"
  );
}

/** Do two JSON-shaped values say the same thing, whatever order their fields came in? */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
