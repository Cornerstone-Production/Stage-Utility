// Insecure-context-safe unique id. crypto.randomUUID only exists in a SECURE
// context (https / localhost); prod is served over plain HTTP, so fall back to a
// timestamp+random id there. (See the prod-insecure-context gotcha.)
export function uid(prefix = "id"): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* insecure context — fall through */
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
