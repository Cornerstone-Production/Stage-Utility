// Where a layout is being rendered, and therefore what it may do.
//
// The capability registry says what an object CAN do; this says which of those
// are live right now. Both are needed: `osc-button` is a control everywhere, but
// pressing it must only work on a surface the operator deliberately made
// interactive.
//
// The matrix below is the specification, copied from the design doc. It is a
// literal table rather than a chain of conditionals so it can be read against
// the doc line by line — the moment it becomes `if (ctx !== "display" && ...)`
// nobody can check it without simulating it.

import type { Capability } from "@main/types/object-capabilities";

/**
 * - `display` — a read-only wall screen. Anyone can walk past it.
 * - `panel` — a console pinned chrome-free to a physical screen: a control surface
 *   the operator deliberately opted in.
 * - `shell` — a console inside the operator app, where navigation exists.
 */
export type RenderContext = "display" | "panel" | "shell";

/**
 * |            | display | panel | shell |
 * |------------|---------|-------|-------|
 * | readout    | yes     | yes   | yes   |
 * | control    | no      | yes   | yes   |
 * | editable   | no      | yes   | yes   |
 * | drilldown  | no      | no    | yes   |
 *
 * Drill-down is inactive on a panel because a chrome-free screen has no
 * navigation to drill INTO — the tap would have nowhere to go. Layout editing
 * is shell-only for a different reason: so a panel pinned to a wall cannot be
 * rearranged by whoever happens to be standing at it.
 */
const MATRIX: Record<RenderContext, Record<Capability, boolean>> = {
  display: { readout: true, control: false, editable: false, drilldown: false },
  panel: { readout: true, control: true, editable: true, drilldown: false },
  shell: { readout: true, control: true, editable: true, drilldown: true },
};

/** Whether a capability is live in this context. */
export function capabilityLive(ctx: RenderContext, cap: Capability): boolean {
  return MATRIX[ctx][cap];
}

/** Layout editing, which is not an object capability but follows the same rule:
 *  shell only, so a pinned panel cannot be rearranged from the floor. */
export function layoutEditingLive(ctx: RenderContext): boolean {
  return ctx === "shell";
}

/**
 * The context a kiosk page is rendering in, from the Output it is serving.
 *
 * A preview is always `display`: it is a picture of what a screen shows, and a
 * preview whose buttons fired for real would mean the Screens page could
 * advance the service by being looked at.
 */
export function contextForOutput(
  outputMode: "display" | "panel" | undefined,
  isPreview: boolean,
): RenderContext {
  if (isPreview) return "display";
  return outputMode === "panel" ? "panel" : "display";
}
