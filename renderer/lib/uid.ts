// Insecure-context-safe unique id. crypto.randomUUID only exists in a SECURE
// context (https / localhost); prod is served over plain HTTP, so it is undefined
// there and calling it throws. getRandomValues is not secure-context-only, so it
// is the fallback, and a timestamp+random id the last resort. (See the
// prod-insecure-context gotcha.)
//
// The one place in the renderer that may touch crypto.randomUUID: uid.test.ts
// walks every renderer source and fails on any other.
export function uid(prefix = "id"): string {
  const c = typeof crypto === "undefined" ? undefined : crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  if (typeof c?.getRandomValues === "function") {
    const hex = Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${hex}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
