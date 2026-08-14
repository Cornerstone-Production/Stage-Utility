// pco-plan-markers.ts — the header rows that mark where a service begins and ends.
//
// PCO exposes no explicit anchor for "this is where the service starts", so a
// purpose-placed header row is the only in-plan signal. These predicates are the
// single definition of that signal: the live countdown, the service-ended check
// and the derived item clock all read the plan through them, and they must agree
// or the same plan would be read three different ways.
//
// Deliberately narrow. Matching loosely would catch "pre-service", "service order"
// and similar innocuous headers, and mis-anchoring the plan is worse than not
// finding a marker at all (both callers have a defined no-marker fallback).

function normalize(title: string): string {
  return (title ?? "").toUpperCase().replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** True when a header title marks the start of the service (the anchor the
 *  "service time" sits at), so items above it are pre-service. */
export function isServiceStartHeader(title: string): boolean {
  const t = normalize(title);
  return t === "SERVICE START" || t.includes("SERVICE START") || t.includes("START OF SERVICE") || t.includes("SERVICE BEGIN");
}

/** True when a header title marks the END of the service — items at/after it are
 *  post-service (buffer, stream padding, dismissal). When the live controller
 *  reaches this boundary the service is over even if PCO still reports an item
 *  "live" (operators often park on a trailing buffer), so recording should stop. */
export function isServiceEndHeader(title: string): boolean {
  const t = normalize(title);
  return t === "SERVICE END" || t.includes("SERVICE END") || t.includes("END OF SERVICE") || t.includes("SERVICE DISMISS");
}
