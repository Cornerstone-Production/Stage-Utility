// is-record.ts — the list guard that sits beside isRecord (main/types/is-record.ts)
// for JSON from a file or a request.

/** An array whose every entry is a string: a list of ids or names from JSON. */
export function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
