// Insecure-context-safe unique id. crypto.randomUUID only exists in a SECURE
// context (https / localhost); prod is served over plain HTTP, so fall back to a
// timestamp+random id there. (See the prod-insecure-context gotcha.)
export function uid(prefix = "id"): string {
  try {
    // ALWAYS prefixed, both branches. It used to return a bare UUID on
    // localhost, so an id looked different depending on where the operator's
    // browser was — and the prefix is the point: a stray id in a log says what
    // it belongs to.
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    /* insecure context — fall through */
  }
  // The timestamp makes a collision essentially impossible without a strong
  // random source, and makes ids sort roughly by creation.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
