// Telling the operator once, and only once they were there to hear it.
//
// The obvious shape — "mark it announced when the check finds it" — spends the
// announcement on an empty room. An update found by the hourly check at 3am,
// with no browser connected, would be recorded as announced and never mentioned
// again. So the mark goes down only when the message actually had somebody to
// go to.
//
// This is why `announcedTag` is a stored fact rather than component state: the
// point is that a second tab, a second machine, and tomorrow morning all agree
// it has already been said.

import { broadcast, channelHasSubscribers } from "../broadcaster.js";
import { updateNoticesStore } from "../update-notices-store.js";
import { isUpdateAvailable } from "./availability.js";
import type { UpdateStatus } from "../../types/state.js";

/** The channel a client listens on for "there is a new version". */
export const NOTICE_CHANNEL = "update:notice";

export interface UpdateNoticePayload {
  /** The tag being offered, which is also the identity of the announcement. */
  tag: string;
  /** How many releases behind this box is, for the wording. */
  count: number;
}

/**
 * Announce an available update, at most once per tag.
 *
 * Returns whether it announced, which is what the tests assert on — a caller in
 * production has nothing useful to do with the answer.
 */
export async function announceIfNew(status: UpdateStatus | null | undefined): Promise<boolean> {
  if (!isUpdateAvailable(status)) return false;

  // The tag is the identity. Falling back to the version keeps a box whose
  // targetTag is unknown from announcing on every single check.
  const tag = status?.targetTag ?? status?.version ?? null;
  if (!tag) return false;

  const current = await updateNoticesStore.load();
  if (current.announcedTag === tag) return false;

  // Nobody listening: say nothing, record nothing, try again next time.
  if (!channelHasSubscribers(NOTICE_CHANNEL)) return false;

  const payload: UpdateNoticePayload = {
    tag,
    count: status?.tagBased ? (status.releasesBehind ?? 0) : (status?.behindUserFacing ?? 0),
  };
  broadcast(NOTICE_CHANNEL, payload);
  await updateNoticesStore.update((cur) => ({ ...cur, announcedTag: tag }));
  return true;
}
