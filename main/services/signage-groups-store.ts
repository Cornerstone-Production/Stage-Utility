// signage-groups-store.ts — named sets of signage displays.
//
// A group holds outputIds, and an output may belong to any number of groups.
// Nothing here decides precedence between two groups that disagree: the SCHEDULE
// list order does, so that the answer is readable off one screen rather than
// derived from a rule about groups.

import type { SignageGroup } from "../types/signage.js";
import { DataStore } from "./data-store.js";
import { errorMessage } from "./errors.js";

export const signageGroupsStore = new DataStore<SignageGroup[]>(
  "signage-groups.json",
  [],
  "config",
);

export function listGroups(): Promise<SignageGroup[]> {
  return signageGroupsStore.load();
}

/**
 * Drop a deleted screen from every tag that named it.
 *
 * Called when an output is removed. Left behind, the id looks like a member
 * that is simply never online: a tag's screen count includes it, so "the foyer
 * (7)" means six — and anything that stood a member in for the tag would be
 * reading a screen that does not exist.
 *
 * Returns how many tags changed, so the caller can say so rather than guess.
 * Never throws: a screen must still be removable when this fails, and the
 * failure is a stale id rather than lost work.
 */
export async function forgetOutputInSignageGroups(
  outputId: string,
): Promise<{ changed: number; error?: string }> {
  try {
    let changed = 0;
    await signageGroupsStore.update((all) =>
      all.map((g) => {
        if (!Array.isArray(g.outputIds) || !g.outputIds.includes(outputId)) return g;
        changed++;
        return { ...g, outputIds: g.outputIds.filter((id) => id !== outputId) };
      }),
    );
    if (changed) console.log(`[signage] removed ${outputId} from ${changed} tag(s)`);
    return { changed };
  } catch (err) {
    // Returned, not swallowed. `0` also means "there was nothing to change", so
    // the caller could not tell a clean no-op from a failure — and the state
    // this function exists to prevent (a screen gone from settings.outputs and
    // still named by every tag) would persist silently.
    return { changed: 0, error: errorMessage(err) };
  }
}
