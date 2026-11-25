// is-record.ts — "is this a plain object I can read fields off": the guard for
// JSON from a file or a request, where an array or null is a malformed value
// rather than an object.
//
// Lives in main/types, not main/services, because the ServiceCue Worker reads it
// through servicecue-publish.ts and a type module never imports from services.
// One definition: a reader of untrusted JSON imports it instead of writing it again.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
