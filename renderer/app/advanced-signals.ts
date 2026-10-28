// advanced-signals.ts — what on Settings > Advanced is asking for attention.
//
// One read, shared: the rail's Advanced row and the Advanced page's tab strip show
// the same two marks from the same two queries, so they cannot disagree. A mark is
// either an update waiting to be installed (Updates tab) or host names waiting for
// an accept or a dismiss (Network tab).

import { isUpdateAvailable } from "@main/services/update/availability";

import { advancedTabPath, type AdvancedTabId } from "../settings/sections/advanced-settings";
import { useHostNamesWaiting } from "./host-names-query";
import { useUpdateStatus } from "./queries";

export interface AdvancedSignals {
  updateAvailable: boolean;
  /** Names that reached the server and are not on the list; a count of names, not requests. */
  hostNamesWaiting: number;
}

export function useAdvancedSignals(): AdvancedSignals {
  const updateAvailable = isUpdateAvailable(useUpdateStatus().data);
  const hostNamesWaiting = useHostNamesWaiting();
  return { updateAvailable, hostNamesWaiting };
}

/**
 * The tab that deals with the signals, or null when there are none. An update wins
 * when both apply: it is the one that ends once taken, and host names are still on
 * the strip's Network tab beside it.
 */
export function advancedSignalTab(signals: AdvancedSignals): AdvancedTabId | null {
  if (signals.updateAvailable) return "updates";
  if (signals.hostNamesWaiting > 0) return "network";
  return null;
}

/** Where the rail's Advanced row goes: the tab its mark is about, or the page's own start. */
export function advancedRailPath(signals: AdvancedSignals): string {
  const tab = advancedSignalTab(signals);
  return tab ? advancedTabPath(tab) : "/settings/advanced";
}
