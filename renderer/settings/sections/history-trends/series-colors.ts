// series-colors.ts — one colour per service type, and it does not move.
//
// The colours used to be `SERIES_COLORS[i]` over the tile order, and the tile
// order is busiest-first. So The Salt Company was blue on Attendance and green
// on Sound, because switching measure re-sorts the tiles; a quiet type that had
// a loud week swapped colours with its neighbour; and a week where one type did
// not record shuffled everything below it. A colour that means a different
// service type between two glances is worse than no colour at all.
//
// So the assignment is by service type id, FIRST COME, and persisted. The
// arithmetic is pure and lives here so it can be tested without a browser; the
// localStorage read and write are the two thin functions at the bottom, and the
// write RETURNS its failure rather than swallowing it.

/**
 * The palette, in the order it is handed out. Theme tokens only — a literal
 * would not follow a theme override, and this file has no way to know which
 * theme is on.
 */
export const TREND_COLORS = [
  // Green, blue, orange — the mockup's order, and the order the busiest service
  // type down gets them. Green leads because the weekend service leads and
  // green is what attendance is drawn in everywhere else in this tab.
  "var(--color-green-9)",
  "var(--color-accent)",
  "var(--color-warn-11)",
  // Then the neutral, for a fourth type. Anything past that cycles.
  "var(--color-fg-muted)",
] as const;

/** Where the assignment lives. Per browser, like every other view preference in
 *  this module. */
export const TREND_COLOR_KEY = "history:trendColors";

/** A service type id to its palette INDEX. The index rather than the colour, so
 *  a palette that gains a token does not have to migrate anybody's store, and a
 *  stored value can be validated as a number. */
export type ColorAssignment = Record<string, number>;

/**
 * `existing` plus an index for every id in `ids` that has none.
 *
 * Three rules, and the whole point is the first:
 *
 *  1. An id that already has an index KEEPS it. Never reassigned — not when the
 *     measure changes, not when the sort changes, not when a type stops
 *     recording and comes back.
 *  2. A new id takes the lowest palette index nothing already holds, so a
 *     church with two service types gets the two most distinct colours rather
 *     than whatever the insertion order happened to land on.
 *  3. Once every index is taken, they cycle — a fifth service type repeats the
 *     first colour rather than getting no colour at all. Two types sharing a
 *     colour is a legibility problem; a type drawn in `undefined` is a bug.
 *
 * Pure: takes the stored map, returns a new one. The caller decides whether it
 * changed and whether to write it.
 */
export function assignColorIndexes(existing: ColorAssignment, ids: readonly string[]): ColorAssignment {
  const next: ColorAssignment = { ...existing };
  for (const id of ids) {
    if (typeof next[id] === "number") continue;
    const taken = new Set(Object.values(next));
    let index = TREND_COLORS.findIndex((_, i) => !taken.has(i));
    // Rule 3. `taken.size` rather than the count of ids, because an id assigned
    // on an earlier pass and no longer present still holds its index.
    if (index < 0) index = taken.size % TREND_COLORS.length;
    next[id] = index;
  }
  return next;
}

/** The colour for an assigned index. Out-of-range wraps rather than returning
 *  undefined — a store hand-edited to `{"x": 99}` draws a line, not a crash. */
export function colorForIndex(index: number): string {
  const n = TREND_COLORS.length;
  return TREND_COLORS[((Math.trunc(index) % n) + n) % n];
}

/**
 * The stored assignment, with anything that is not a number dropped.
 *
 * Falls back to an empty map on an unreadable store: a browser in private mode
 * simply gets a fresh assignment for this visit, which is the state it was
 * already in. Nothing is lost — the assignment is derived from the ids on
 * screen, not operator data.
 */
export function readColorAssignment(): ColorAssignment {
  try {
    const raw = localStorage.getItem(TREND_COLOR_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ColorAssignment = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.trunc(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist an assignment. Returns the failure rather than swallowing it: the
 *  caller logs it, so an operator whose colours move every reload has a
 *  `[history]` line saying why. */
export function writeColorAssignment(map: ColorAssignment): Error | null {
  try {
    localStorage.setItem(TREND_COLOR_KEY, JSON.stringify(map));
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
