// Is there an update to install, and how many?
//
// One definition, because three things now ask: the Advanced panel, the toast,
// and the dot on the nav row. It lived as an inline expression in the panel; a
// second and third copy is how a dot ends up disagreeing with the panel it is
// pointing at.

import type { UpdateStatus } from "../../types/state.js";

/**
 * How many releases this box is behind.
 *
 * Once the server follows tags, a RELEASE is the unit an operator acts on and
 * the commit count behind it is detail — so `releasesBehind` wins wherever it
 * is meaningful, and the commit-based count is the fallback for a box that is
 * not tag-based.
 */
export function availableCount(status: UpdateStatus | null | undefined): number {
  if (!status) return 0;
  return status.tagBased ? (status.releasesBehind ?? 0) : (status.behindUserFacing ?? 0);
}

/** Whether to tell the operator anything at all. */
export function isUpdateAvailable(status: UpdateStatus | null | undefined): boolean {
  return availableCount(status) > 0;
}
