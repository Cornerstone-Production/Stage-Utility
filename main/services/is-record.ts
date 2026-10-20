// is-record.ts — "is this a plain object I can read fields off": the guard for
// JSON from a file or a request, where an array or null is a malformed value
// rather than an object.
//
// Four modules each wrote this same line; one now, so a fifth reader of
// untrusted JSON imports it instead of writing it again.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
