// signage-groups-store.ts — named sets of signage displays.
//
// A group holds outputIds, and an output may belong to any number of groups.
// Nothing here decides precedence between two groups that disagree: the SCHEDULE
// list order does, so that the answer is readable off one screen rather than
// derived from a rule about groups.

import type { SignageGroup } from "../types/signage.js";
import { DataStore } from "./data-store.js";

export const signageGroupsStore = new DataStore<SignageGroup[]>(
  "signage-groups.json",
  [],
  "config",
);

export function listGroups(): Promise<SignageGroup[]> {
  return signageGroupsStore.load();
}

/** Every group this output belongs to, in stored order — which is the order the
 *  resolver walks when looking for a default playlist. */
export function groupsForOutput(groups: SignageGroup[], outputId: string): SignageGroup[] {
  return groups.filter((g) => g.outputIds.includes(outputId));
}
