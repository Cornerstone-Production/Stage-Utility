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
