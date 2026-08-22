// signage-cycle.ts — what a signage display should be showing, from the clock.
//
// PURE, and deliberately so. Playback is DERIVED, never driven by messages: a
// display computes its position from the playlist's startedAt and the item
// durations, so every screen resolving the same playlist computes the same
// answer and they stay in step with no traffic between them. A server that
// pushed "show item 3 now" would drift the moment one screen missed a message.
//
// It also means video's variable lengths need no special handling — a clip is
// just an item whose duration happens to come from the file.

import type { SignageHorizon, SignageHorizonEntry } from "@main/types/signage";

/**
 * How long one revolution takes.
 *
 * The PLAIN SUM of durations. A transition occupies the first N ms of the
 * incoming item's own slot rather than sitting between items, precisely so this
 * stays true — if a transition lengthened the cycle, two screens would fall out
 * of step by one transition per revolution and drift visibly within an hour.
 */
export function cycleMs(items: { durationMs: number }[]): number {
  let total = 0;
  // Negatives clamp to zero rather than subtracting: a bad duration should cost
  // one item's turn, not run the cycle backwards.
  for (const i of items) total += Math.max(0, i.durationMs);
  return total;
}

/**
 * Which item is on screen, and how far into it.
 *
 * Null when there is nothing playable — an empty playlist, or one whose items
 * all have no duration. The caller renders black; a modulo by zero here would
 * crash a wall screen instead.
 */
export function itemAt(
  items: { durationMs: number }[],
  elapsedMs: number,
): { index: number; offsetMs: number } | null {
  const total = cycleMs(items);
  if (total <= 0) return null;

  // Double modulo: a display whose clock sits behind the playlist's startedAt
  // produces a negative elapsed time, and `-1000 % 28000` is -1000 in JS. That
  // would fall straight through the walk below and off the end.
  let pos = ((elapsedMs % total) + total) % total;

  for (let i = 0; i < items.length; i++) {
    const d = Math.max(0, items[i].durationMs);
    // Half-open, so an instant belongs to exactly one item and two displays
    // cannot land on different sides of a boundary.
    if (pos < d) return { index: i, offsetMs: pos };
    pos -= d;
  }

  // Unreachable while total > 0. Falling back to the last item rather than null
  // keeps a floating-point edge from blanking a screen.
  return { index: items.length - 1, offsetMs: 0 };
}

/**
 * The horizon entry covering `nowMs`, or null when the clock is outside it.
 *
 * Null rather than the nearest entry: guessing is how a stale horizon keeps a
 * display confidently showing last week's content. The caller decides what to do
 * with "I do not know", and that decision differs by whether the server is
 * reachable.
 */
export function entryAt(h: SignageHorizon, nowMs: number): SignageHorizonEntry | null {
  for (const e of h) if (nowMs >= e.from && nowMs < e.until) return e;
  return null;
}
