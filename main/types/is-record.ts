// is-record.ts — "is this a plain object I can read fields off": the guard for
// JSON from a file or a request, where an array or null is a malformed value
// rather than an object, and isStringList for a list of names.
//
// Lives in main/types, not main/services: the ServiceCue Worker imports it from
// validate.ts, and a type module never imports from services.
// One definition: a reader of untrusted JSON imports it instead of writing it again.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An array whose every entry is a string: a list of ids or names from JSON. */
export function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
