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
