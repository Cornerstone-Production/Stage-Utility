// A Planning Center plan note, turned into checklist rows.
//
// The point of this file is that a checklist an operator maintains in PCO is
// the SAME checklist they tick off here. Nobody wants to keep a production
// checklist in two places, and a copy in Stage Utility would go stale the first
// week somebody edited the note and not the copy.
//
// PURE, and deliberately so: every interesting decision here — what counts as a
// row, and which tick belongs to which row after the note is edited — is
// testable without a network, a plan, or a render.
//
// Read-only, in one direction. PCO has no per-line state to write back to, so a
// tick lives here and never leaves. That has to stay true in the UI copy as
// well: an operator who thinks their team can see the ticks in PCO is being
// misled by us.

/** One note on a plan, flattened from PCO's JSON:API. */
export interface PlanNoteDTO {
  id: string;
  /** PCO puts this on the note's own attributes — no second request. */
  categoryName: string;
  content: string;
  /** Teams the note is assigned to. Empty = assigned to nobody in particular. */
  teamNames: string[];
}

export interface PlanChecklistItem {
  /**
   * Identity, and the thing a tick is stored against.
   *
   * Derived from the row's WORDING, not its position: inserting a line at the
   * top of a note must not shift every tick below it down one, which is exactly
   * what an index-based key does. Reordering a note therefore carries the ticks
   * along with their rows, and rewording a row clears its tick — correct,
   * because a reworded row is a different job.
   */
  key: string;
  text: string;
  categoryName: string;
  teamNames: readonly string[];
}

/**
 * Bullet markers an operator might plausibly type at the start of a line.
 *
 * The bracket forms are here because somebody writing a checklist in a
 * plain-text box reaches for a checkbox, and having it silently become part of
 * the row's text would be a small daily annoyance.
 */
const BULLET = /^\s*(?:[-*•·]|\[\s*[xX]?\s*\])\s+/;

/** Whitespace-only, or a horizontal rule somebody used as a separator. */
const SKIP = /^\s*(?:[-*_=]{3,})?\s*$/;

/**
 * The rows in one note's content.
 *
 * A note is prose, not a data structure, so this reads it the way a person
 * would: if ANY line is bulleted, the bulleted lines are the list and
 * everything else is the preamble around it. If none are, every non-blank line
 * is a row.
 *
 * That rule is what lets a note carry both context and a checklist without
 * anyone being taught a syntax — "Doors at 8. Vans unloaded by 8:30." stays
 * context when it sits above a bulleted list, and becomes two rows when it does
 * not, which is the reading a person would give it either way.
 */
export function noteLines(content: string): string[] {
  const lines = content.split(/\r?\n/).filter((l) => !SKIP.test(l));
  const bulleted = lines.filter((l) => BULLET.test(l));
  const chosen = bulleted.length > 0 ? bulleted : lines;
  return chosen.map((l) => l.replace(BULLET, "").trim()).filter(Boolean);
}

/**
 * The comparison form of a row, for keying a tick.
 *
 * Case and inner spacing are normalised away so that fixing a typo or a double
 * space does not silently untick a row somebody already did. Anything that
 * changes the actual words does clear it.
 */
function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Every row across a plan's notes, in note order then line order.
 *
 * @param notes  The plan's notes, already filtered to the categories/teams the
 *   operator chose. This function does not decide what is on the list — only
 *   what the chosen notes say.
 */
export function planChecklistItems(notes: readonly PlanNoteDTO[]): PlanChecklistItem[] {
  const out: PlanChecklistItem[] = [];
  // Identical wording twice in one category is rare but real ("Check batteries"
  // under two headings). Without an occurrence number both rows share a key and
  // tick together, which reads as a bug rather than as a duplicate.
  const seen = new Map<string, number>();

  for (const note of notes) {
    for (const text of noteLines(note.content)) {
      const base = `${note.categoryName} ${fold(text)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.push({
        key: n === 1 ? base : `${base} ${n}`,
        text,
        categoryName: note.categoryName,
        teamNames: note.teamNames,
      });
    }
  }
  return out;
}

/** One row as the UI receives it: the note's wording plus this plan's tick. */
export interface PlanChecklistRow extends PlanChecklistItem {
  done: boolean;
}

export interface PlanChecklistDTO {
  /** The plan these ticks belong to. Null when no plan is selected. */
  planId: string | null;
  rows: PlanChecklistRow[];
  /**
   * PCO is connected and a plan is selected, but no category or team has been
   * chosen to read from.
   *
   * A distinct state from "chosen, and there is nothing on the list this week",
   * because the two need opposite copy: one is a setting nobody has filled in,
   * the other is a checklist that is genuinely empty. Collapsing them into one
   * empty box is how a feature reads as broken.
   */
  unconfigured: boolean;
}

/**
 * The notes an operator has chosen to see, by category name and/or team name.
 *
 * Both empty means nothing is chosen, and the answer is NO notes rather than
 * all of them. A checklist that silently fills with every note on the plan the
 * moment PCO is connected — song keys, lighting cues, a reminder about the
 * parking lot — is worse than an empty one, and there would be no way to tell
 * from the widget that nobody had asked for them.
 */
export function selectNotes(
  notes: readonly PlanNoteDTO[],
  categories: readonly string[],
  teams: readonly string[],
): PlanNoteDTO[] {
  if (categories.length === 0 && teams.length === 0) return [];
  const cats = new Set(categories.map((c) => c.toLowerCase()));
  const tms = new Set(teams.map((t) => t.toLowerCase()));
  return notes.filter((n) => {
    const byCat = cats.size > 0 && cats.has(n.categoryName.toLowerCase());
    const byTeam = tms.size > 0 && n.teamNames.some((t) => tms.has(t.toLowerCase()));
    return byCat || byTeam;
  });
}
