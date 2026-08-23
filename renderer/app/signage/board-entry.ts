// board-entry.ts — which horizon entry an OPERATOR surface should show.
//
// Deliberately a different rule from the one a display follows. A display uses
// entryAt, which answers null outside the horizon and never guesses: guessing is
// how a stale plan keeps a wall confidently showing last week's content.
//
// A board is not a wall. It is answering "what is winning right now", it is
// sitting next to the server that just recomputed, and the honest answer to a
// few hundred milliseconds of skew is the first entry — not nothing.
//
// That skew is real and reproducible. Reordering a schedule makes the server
// rebuild the horizon starting at ITS now; the board's clock ticks once a
// second, so until the next tick the board's `at` is behind the horizon's start,
// no entry matches, and the winning marker DISAPPEARS before reappearing on the
// right row. Reported as "the green outline is delayed after reordering".

import type { SignageHorizon, SignageHorizonEntry } from "@main/types/signage";

import { entryAt } from "../../main/signage-cycle";

/**
 * The entry covering `atMs`, treating a clock behind the horizon as its start.
 *
 * Still null past the END of the horizon: that means the plan is genuinely stale
 * and the board should say nothing rather than pick the last thing it knew.
 */
export function boardEntry(horizon: SignageHorizon, atMs: number): SignageHorizonEntry | null {
  if (horizon.length === 0) return null;
  // entryAt does the walk — the CLAMP is the whole difference, and writing the
  // loop out again hid that behind a copy of it.
  return entryAt(horizon, Math.max(atMs, horizon[0].from));
}

/** Every schedule winning on at least one screen right now.
 *
 *  A SET, not one id: two schedules winning for two different groups are both
 *  winning, and marking only one would be a lie about the other. */
export function winningScheduleIds(
  horizons: Record<string, SignageHorizon>,
  atMs: number,
): Set<string> {
  const ids = new Set<string>();
  for (const horizon of Object.values(horizons)) {
    const entry = boardEntry(horizon, atMs);
    if (entry?.reason === "schedule" && entry.reasonId) ids.add(entry.reasonId);
  }
  return ids;
}

/** Which outputs a schedule is winning on, so the marker can name them rather
 *  than saying a bare "winning" that reads as "the one that is winning". */
export function winningOutputsFor(
  horizons: Record<string, SignageHorizon>,
  atMs: number,
  scheduleId: string,
): string[] {
  const out: string[] = [];
  for (const [outputId, horizon] of Object.entries(horizons)) {
    const entry = boardEntry(horizon, atMs);
    if (entry?.reason === "schedule" && entry.reasonId === scheduleId) out.push(outputId);
  }
  return out;
}
