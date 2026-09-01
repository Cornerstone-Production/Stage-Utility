import { useCallback } from "react";

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
 */
export function useServiceTimeline(): ServiceTimeline | null {
  const read = useCallback(() => invoke<ServiceTimeline | null>("serviceTimeline:getCurrent"), []);
  return useStatusChannel<ServiceTimeline>(read, "service-timeline:history");
}
