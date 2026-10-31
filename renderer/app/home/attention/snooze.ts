// Which items a snooze is hiding.
//
// A snooze hides a KEY at the SEVERITY it had. An item that comes back at the
// same severity or lower is still handled; one that has got worse is not -- a
// mic at 19% that someone snoozed on Thursday must shout when it is in someone's
// hand. Clearing and returning does not matter: the key is what is remembered.

import type { HomeSnooze } from "@main/types/home-snoozes";

import type { AttentionItem, AttentionSeverity } from "./types";

const RANK: Record<AttentionSeverity, number> = { warn: 1, critical: 2 };

/** True while `snooze` still covers `item`: same key, and the item no worse than when snoozed. */
export function snoozeCovers(snooze: HomeSnooze | undefined, item: AttentionItem): boolean {
  return snooze !== undefined && RANK[item.severity] <= RANK[snooze.severity];
}

export function partitionSnoozed(
  items: readonly AttentionItem[],
  snoozes: readonly HomeSnooze[],
): { shown: AttentionItem[]; snoozed: AttentionItem[] } {
  const byKey = new Map(snoozes.map((s) => [s.key, s]));
  const shown: AttentionItem[] = [];
  const snoozed: AttentionItem[] = [];
  for (const item of items) (snoozeCovers(byKey.get(item.key), item) ? snoozed : shown).push(item);
  return { shown, snoozed };
}
