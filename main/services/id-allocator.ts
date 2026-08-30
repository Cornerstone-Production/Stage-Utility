// Hands out an id that has never been used before.
//
// PURE, so the rule is testable without a store: the caller owns persistence and
// passes the floor in, and gets the next floor back to save.
//
// Two independent inputs, because either alone is wrong:
//
//   THE FLOOR is a persisted high-water mark. It is what stops a deleted id
//   coming back — `max(existing) + 1` cannot know about something that is gone.
//
//   THE EXISTING IDS are the collision check. A floor can be STALE — a restored
//   backup carries a counter written before the ids in it — and issuing an id
//   that already exists is worse than reuse: two live things sharing a key that
//   slots.json, bookmarks and QR codes all treat as unique.

export function nextId(
  prefix: string,
  existingIds: readonly string[],
  floor: number,
): { id: string; nextFloor: number } {
  const used = new Set(existingIds);
  const highest = existingIds
    .map((id) => parseInt(id.slice(prefix.length + 1), 10))
    .filter((n) => Number.isFinite(n));
  let n = Math.max(floor, highest.length > 0 ? Math.max(...highest) + 1 : 1);
  while (used.has(`${prefix}-${n}`)) n++;
  return { id: `${prefix}-${n}`, nextFloor: n + 1 };
}

/**
 * What each kind of id is called, and the lowest number it may ever use.
 *
 * `display-1` is the reserved primary output (PRIMARY_DISPLAY_ID), so created
 * displays start at display-2. Views have no reserved id.
 *
 * Kept here, beside the allocator, so the prefix and the floor cannot drift
 * apart in a caller that passes one without the other.
 */
export const ID_KINDS = {
  view: { prefix: "view", first: 1 },
  output: { prefix: "display", first: 2 },
} as const;

export type IdKind = keyof typeof ID_KINDS;

/**
 * The floor an install that has never recorded one should start from: the number
 * of the next id it would issue.
 *
 * A floor is only ever written when an id is ISSUED, so an install that upgrades
 * into this has ids and no floor. Its first allocation would then fall back to
 * the collision check alone — `max(existing) + 1` — and delete-then-create is
 * exactly the sequence that reaches it. One free reuse of the highest id, after
 * which it self-heals, which is precisely why nobody would report it.
 */
export function initialFloor(kind: IdKind, existingIds: readonly string[]): number {
  const { prefix, first } = ID_KINDS[kind];
  // `nextFloor` is one past the id this would issue, so the floor that issues it
  // is one less. Routed through nextId rather than reimplemented so the number
  // parsing and the collision walk cannot disagree with the allocator.
  return nextId(prefix, existingIds, first).nextFloor - 1;
}
