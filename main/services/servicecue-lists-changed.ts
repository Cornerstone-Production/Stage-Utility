// servicecue:lists — tells an open ServiceCue screen or rundown page that the layouts or
// the category roles were saved, so it re-reads them now instead of on its next timer.
//
// Announced from each store's after-save hook, the one place every write through a store
// passes: the layouts and roles routes, the role seed, a layout import, the migration a load
// runs. A write path added later cannot forget it. A config restore writes the files
// directly and restarts the server instead; the connect burst re-sends the last frame.
//
// Only the broadcast is gated on subscribers. The sequence advances on every write, so the
// frame the connect burst re-sends is exact for a page that subscribes later.

import { randomUUID } from "node:crypto";

import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { SERVICECUE_LISTS_CHANNEL, type ServiceCueListsChanged } from "../types/servicecue-lists.js";

const EPOCH = randomUUID();
let last: ServiceCueListsChanged = { epoch: EPOCH, seq: 0 };

/** The last frame, for the connect burst. */
export function serviceCueListsState(): ServiceCueListsChanged {
  return last;
}

/** A store's after-save hook: number the write and, if anything is listening, say so. */
export function announceServiceCueListsSaved(): void {
  last = { epoch: EPOCH, seq: last.seq + 1 };
  if (channelHasSubscribers(SERVICECUE_LISTS_CHANNEL)) broadcast(SERVICECUE_LISTS_CHANNEL, last);
}
