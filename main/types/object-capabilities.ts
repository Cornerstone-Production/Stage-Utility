// What each layout object can DO, as opposed to what it looks like.
//
// The rendering context decides which of these are live: a wall display renders
// readouts only, a touch panel adds controls and editing, and a console in the
// operator shell adds drill-down. That gating is what stops a wall screen
// showing a live button by accident, and it needs one place that says which
// objects are buttons in the first place.
//
// EXHAUSTIVENESS IS COMPILER-ENFORCED. `LayoutObjectType` is derived from the
// LayoutObjectConfig union, so `Record<LayoutObjectType, ...>` fails `tsc` the
// moment a new object type is added without an entry here. That matters more
// than it looks: the failure mode is a new control object rendering ungated on
// every wall display, and a source-scanning test would have been satisfied by
// the type merely being mentioned. The repository has shipped that bug.

import type { LayoutObjectType } from "./views.js";

/**
 * - `readout` — renders data
 * - `control` — invokes an ActionDef
 * - `drilldown` — declares a route target
 * - `editable` — writes back to a store
 *
 * These compose: an SPL meter is a readout AND a drill-down target.
 */
export type Capability = "readout" | "control" | "drilldown" | "editable";

/**
 * Every object type, and what it can do.
 *
 * Enumerated rather than defaulted. A default is precisely how a new control
 * object would arrive treated as a harmless readout, so there is no default:
 * adding a type to the union forces a decision here.
 */
export const CAPABILITIES: Record<LayoutObjectType, Capability[]> = {
  // ── Controls. The only types that invoke an action. ──────────────────────
  "osc-button": ["control"],
  "rosstalk-button": ["control"],
  "live-controls": ["control"],

  // ── Readouts with somewhere to go when pressed in the shell. ─────────────
  "spl-meter": ["readout", "drilldown"],
  "people-counter": ["readout", "drilldown"],
  "wireless-channel": ["readout", "drilldown"],
  "integration-status": ["readout", "drilldown"],

  // ── Plain readouts. ─────────────────────────────────────────────────────
  "baptism-timer": ["readout"],
  "brand-logo": ["readout"],
  "charger-battery": ["readout"],
  clock: ["readout"],
  // A container renders its children; the children carry their own capabilities.
  container: ["readout"],
  "countdown-timer": ["readout"],
  "current-service-item": ["readout"],
  "current-slide-notes": ["readout"],
  "current-slide-text": ["readout"],
  image: ["readout"],
  "ndi-video": ["readout"],
  "next-service-item": ["readout"],
  "next-slide-text": ["readout"],
  "obs-status": ["readout"],
  "people-graph": ["readout"],
  "people-panel": ["readout"],
  "plan-attachment": ["readout"],
  "pp-timer": ["readout"],
  "reaper-status": ["readout"],
  "record-status": ["readout"],
  "section-chip": ["readout"],
  "service-order": ["readout"],
  "service-pacing": ["readout"],
  shape: ["readout"],
  "slide-progress": ["readout"],
  "slide-thumbnail": ["readout"],
  "slots-grid": ["readout"],
  text: ["readout"],
  "transcript-strip": ["readout"],
  "view-embed": ["readout"],
  "wireless-summary": ["readout"],
};

/**
 * Where a drill-down-capable object goes when pressed in the operator shell.
 *
 * Only the four the design doc names. Others can gain a target later without a
 * schema change — an object is only reachable here if it declares `drilldown`
 * above, so an entry that is not also a drill-down capability does nothing.
 */
export const DRILLDOWN: Partial<Record<LayoutObjectType, string>> = {
  "spl-meter": "/history",
  "people-counter": "/history",
  "wireless-channel": "/patch",
  "integration-status": "/settings/integrations",
};

export function hasCapability(type: LayoutObjectType, cap: Capability): boolean {
  return CAPABILITIES[type]?.includes(cap) ?? false;
}

/** Whether this object type invokes something. Used by the migration to decide
 *  a View is a console, and by the renderer to decide whether to bind a press. */
export function isControl(type: LayoutObjectType): boolean {
  return hasCapability(type, "control");
}
