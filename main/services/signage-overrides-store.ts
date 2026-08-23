// signage-overrides-store.ts — live take-overs, one per group.
//
// RUNTIME, not config, and the distinction is deliberate.
//
// An override has to survive a server restart: an announcement that vanished
// because the box rebooted mid-service is a real failure, and the operator who
// set it is not standing at a laptop. So it is persisted.
//
// But it must NOT ride in a config snapshot. Restoring a two-week-old backup
// would put a forgotten announcement back on a wall with nobody having asked for
// it, and the operator would have no reason to look for it. An override is a
// statement about right now, not about how this install is configured.

import type { SignageOverride } from "../types/signage.js";
import { DataStore } from "./data-store.js";

export const signageOverridesStore = new DataStore<SignageOverride[]>(
  "signage-overrides.json",
  [],
  "runtime",
);

export function listOverrides(): Promise<SignageOverride[]> {
  return signageOverridesStore.load();
}

/** Set (or replace) the override on one group. One per group: a second take-over
 *  on the same group is a correction, not an addition. */
export function setOverride(o: SignageOverride): Promise<SignageOverride[]> {
  return signageOverridesStore.update((all) => [...all.filter((x) => x.groupId !== o.groupId), o]);
}

export function clearOverride(groupId: string): Promise<SignageOverride[]> {
  return signageOverridesStore.update((all) => all.filter((x) => x.groupId !== groupId));
}
