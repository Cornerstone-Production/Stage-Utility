// ids.ts — ids for records the operator creates in the browser.
//
// NOT crypto.randomUUID: production is served over plain HTTP, which is not a
// secure context, and randomUUID is undefined there. It works on localhost, so
// the failure shows up only once it is on the wall.

/** A short unique id, prefixed so a stray one in a log says what it belongs to. */
export function newSignageId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  // The timestamp makes a collision essentially impossible without needing a
  // strong random source, and makes ids sort roughly by creation.
  return `${prefix}-${Date.now().toString(36)}${rand}`;
}
