// Decide whether a plan item going live should start a phase of the baptism timer.
//
// Two triggers, because the two ends of a baptism differ in how stable they are:
//
//   testimonies  happen during an item named the same every week ("Baptism
//                Stories"), so a keyword finds it with no weekly setup
//   baptisms     happen during whichever songs are on that week, so no keyword can
//                ever find them — that end is bound to a specific item per plan
//
// Binding both ends also fixes an accuracy problem rather than papering over it.
// Between the testimonies and the baptisms there is usually several minutes of
// vows, prayer and preaching; with only a manual "start baptisms" button that gap
// lands on whichever person is timing. Started from the item the baptisms actually
// happen during, it belongs to neither phase.

import type { BaptismAutoStart, BaptismTriggers } from "../types/stage.js";

/** What the timer should do when an item goes live. */
export type AutoAction = "start-testimonies" | "start-baptisms" | null;

export interface AutoStartInput {
  /** The item that just went live. */
  itemId: string | null | undefined;
  itemTitle: string | null | undefined;
  /** The timer's phase right now. */
  phase: "idle" | "testimony" | "baptism";
  /** Per-plan bindings, if this plan has any. */
  triggers: BaptismTriggers | null | undefined;
  /** The keyword rule, if configured and enabled. */
  auto: BaptismAutoStart | null | undefined;
}

/**
 * The action an item going live should cause, or null for "leave the timer alone".
 *
 * Deliberately conservative. It only ever moves the timer FORWARD from idle into
 * testimonies, or from testimonies into baptisms — the two transitions an operator
 * would otherwise be making by hand at the same moment they are advancing PCO.
 * It never restarts, never rewinds, and never fires while the phase it would start
 * is already running, so a re-fired item or a PCO re-sync cannot wipe a session
 * that is underway.
 */
export function autoStartAction(input: AutoStartInput): AutoAction {
  const { itemId, itemTitle, phase, triggers, auto } = input;

  // Baptisms first: it is the more specific rule, and the item bound to it could in
  // principle also match the testimony keyword.
  if (phase === "testimony" && triggers?.baptismItemId && itemId && triggers.baptismItemId === itemId) {
    return "start-baptisms";
  }

  if (phase !== "idle") return null; // already running; nothing else may interrupt

  if (triggers?.testimonyItemId && itemId && triggers.testimonyItemId === itemId) {
    return "start-testimonies";
  }

  const keyword = auto?.enabled ? auto.testimonyKeyword.trim().toLowerCase() : "";
  if (keyword && (itemTitle ?? "").toLowerCase().includes(keyword)) {
    return "start-testimonies";
  }

  return null;
}
