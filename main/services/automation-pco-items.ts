// automation-pco-items.ts — finding a plan item by what it is called.
//
// Title, not id. A plan's items are new objects every week, so an id chosen from
// a dropdown on Tuesday is dead by Sunday. The dropdown exists for convenience
// and stores the title, which is the same choice pco.item-reached already makes.
//
// Shared by the trigger and the action deliberately: a trigger that fires on an
// item the action then fails to recognise is the worst possible split, and two
// copies of "does this title match" is how that happens.

/** Anything with a title. Generic so the plan rundown and the derived schedule
 *  are matched by the same rule rather than two drifting copies of it. */
export type PlanItem = { title: string };

/** First item whose title contains `title`, case-insensitively, or null. */
export function findItemByTitle<T extends PlanItem>(items: T[], title: string): T | null {
  const want = title.trim().toLowerCase();
  // An empty needle would otherwise match the first item and fire the wrong cue.
  if (!want) return null;
  return items.find((i) => i.title.toLowerCase().includes(want)) ?? null;
}

/** Whether to step Live forward, and the wording for the Activity log either way. */
export type AdvanceVerdict = { advance: boolean; reason: string };

/**
 * Decide whether advancing one item lands where the rule intends.
 *
 * PCO has no "jump to item" action — go_to_next_item is all there is — so a rule
 * can only ever take ONE step. This is the check that makes that step safe: if
 * the plan is not sitting where the rule expected, stepping anyway would fire
 * whatever item happens to be next, live, in front of the room.
 *
 * An empty guard means the caller wants an unconditional single step.
 */
export function advanceGuard(nextItemTitle: string | null, guardTitle: string): AdvanceVerdict {
  const want = guardTitle.trim();
  if (!want) return { advance: true, reason: "no guard set" };
  if (!nextItemTitle) return { advance: false, reason: "PCO reports no next item" };
  const hit = findItemByTitle([{ title: nextItemTitle }], want);
  return hit
    ? { advance: true, reason: `next item is "${nextItemTitle}"` }
    : { advance: false, reason: `next item is "${nextItemTitle}", not "${want}"` };
}
