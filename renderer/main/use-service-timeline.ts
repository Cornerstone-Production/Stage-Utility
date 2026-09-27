import { useCallback, useState } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/**
 * The in-progress service timeline (planned vs. actual per-item timing), pushed on
 * the "service-timeline:history" channel each time an item changes. Hydrates once
 * from the current record, then stays live. Backs the "Service pacing" layout
 * object's whole-service scope. Returns null when nothing is recording yet.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job — see
 * the note there. The channel fires on item changes, so a read landing after one
 * puts the previous item back on the pacing widget until the next change.
 *
 * "service-timeline:history" also broadcasts a post-hoc History edit of a service
 * that already ENDED — an item-time correction made on last week's record, say —
 * which is not a new event about whatever is live right now. While this hook
 * holds an OPEN record (its own `endedAt` still null), a push naming a
 * DIFFERENT, already-ended service that STARTED EARLIER is ignored — accepting
 * it replaced the live plan lane and the "Service pacing" layout object with the
 * edited past service's pacing until the next item transition on the live one.
 * An ended record for a service that started later is accepted: it is how a
 * stale replayed frame (a display reconnecting after both services ran) gets
 * corrected. A push for the SAME service still updates normally; so does any
 * push once this hook's own record has itself ended.
 */
export function useServiceTimeline(): ServiceTimeline | null {
  const read = useCallback(() => invoke<ServiceTimeline | null>("serviceTimeline:getCurrent"), []);
  const { value: pushed } = useStatusChannel<ServiceTimeline>(read, "service-timeline:history");

  // The last value THIS hook actually accepted, and the last `pushed` it has
  // already reacted to — React's own "adjusting state when a prop changes"
  // pattern (react.dev), computed DURING render rather than in an effect: an
  // effect would commit the wrong value for one extra render before
  // correcting it, and the layout objects and charts reading this hook would
  // flash the edited past service's own pacing before catching up.
  const [accepted, setAccepted] = useState<ServiceTimeline | null>(null);
  const [seen, setSeen] = useState<ServiceTimeline | null>(null);
  if (pushed !== seen) {
    setSeen(pushed);
    const reject =
      pushed !== null &&
      accepted !== null &&
      pushed.serviceKey !== accepted.serviceKey &&
      accepted.endedAt == null &&
      pushed.endedAt != null &&
      Date.parse(pushed.startedAt) < Date.parse(accepted.startedAt);
    if (!reject) setAccepted(pushed);
  }
  return accepted;
}
