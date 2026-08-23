// signage-hold.ts — what a display shows when the server is not there.
//
// PURE, and one line of arithmetic, because the rule turns out to be simpler
// than it first sounds:
//
//   AT A BOUNDARY, A DISPLAY ADVANCES ONLY IF IT IS CONNECTED.
//
// which is the same thing as: WHILE DISCONNECTED, THE CLOCK STOPS. A display
// that stops advancing its clock at the instant the stream dropped keeps playing
// whatever it was playing, never reaches the next boundary, and resumes exactly
// where it should when the clock starts again.
//
// Stating it that way removes every piece of machinery the first version needed
// — no held entry to thread, no ref read during render, no state to update on a
// boundary. There is still no grace period and no threshold to tune: a blip that
// resolves before the next boundary freezes the clock inside the entry it was
// already in, so nothing changes at all.

import type { SignageHorizon, SignageHorizonEntry } from "@main/types/signage";

import { entryAt } from "./signage-cycle";

/**
 * The entry to draw.
 *
 * @param disconnectedAtMs when the event stream went down, or null while it is
 *   up. This is the whole of the offline behaviour: it freezes the clock.
 */
export function pickEntry(o: {
  horizon: SignageHorizon;
  nowMs: number;
  disconnectedAtMs: number | null;
}): SignageHorizonEntry | null {
  // Connected: the horizon is authoritative, so a display that has been offline
  // for hours jumps straight to what is correct rather than finishing what it
  // was doing.
  return entryAt(o.horizon, o.disconnectedAtMs ?? o.nowMs);
}

/**
 * What a display plays when it BOOTS with no server reachable.
 *
 * The group's DEFAULT entry, and deliberately not a function of time at all. A
 * Pi has no real-time clock: after a cold boot offline it may believe almost
 * anything, so consulting a window would be worse than useless — it would pick
 * confidently and wrongly. The default playlist is the thing an operator
 * deliberately assigned for exactly this case.
 *
 * Null when the horizon names no default, which renders black. Falling back to
 * the most recent scheduled entry would put last week's content on a wall
 * looking entirely correct.
 */
export function bootEntry(persisted: SignageHorizon): SignageHorizonEntry | null {
  return persisted.find((e) => e.reason === "default" && e.playlist) ?? null;
}
