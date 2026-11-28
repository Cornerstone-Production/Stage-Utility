// advanced-signals.ts — what on Settings > Advanced is asking for attention.
//
// One read, shared: the rail's Advanced row and the Advanced page's tab strip show
// the same marks from the same reads, so they cannot disagree. A mark is an update
// waiting to be installed (Updates tab), host names waiting for an accept or a
// dismiss (Network tab), or another server answering with this server's id
// (Network tab, red: something is wrong, not waiting).

import { isUpdateAvailable } from "@main/services/update/availability";

import { advancedTabPath, type AdvancedTabId } from "../settings/sections/advanced-settings";
import { useHostNamesWaiting } from "./host-names-query";
import { useUpdateStatus } from "./queries";

export interface AdvancedSignals {
  updateAvailable: boolean;
  /** Names that reached the server and are not on the list; a count of names, not requests. */
  hostNamesWaiting: number;
  /** Other servers heard answering discovery with this server's id. */
  duplicateServers: number;
}

/** `state` is the stage state the caller already holds, so this opens no read of its own. */
export function useAdvancedSignals(state: Pick<StageState, "serverIdentity"> | null | undefined): AdvancedSignals {
  const updateAvailable = isUpdateAvailable(useUpdateStatus().data);
  const hostNamesWaiting = useHostNamesWaiting();
  const duplicateServers = state?.serverIdentity?.duplicates?.length ?? 0;
  return { updateAvailable, hostNamesWaiting, duplicateServers };
}

/**
 * The tab that deals with the signals, or null when there are none. Another server
 * with this id wins over everything. Otherwise an update wins when both apply: it
 * is the one that ends once taken, and host names are still on the strip's Network
 * tab beside it.
 */
export function advancedSignalTab(signals: AdvancedSignals): AdvancedTabId | null {
  // A duplicate id wins: screens are switching between two servers now.
  if (signals.duplicateServers > 0) return "network";
  if (signals.updateAvailable) return "updates";
  if (signals.hostNamesWaiting > 0) return "network";
  return null;
}

/** Where the rail's Advanced row goes: the tab its mark is about, or the page's own start. */
export function advancedRailPath(signals: AdvancedSignals): string {
  const tab = advancedSignalTab(signals);
  return tab ? advancedTabPath(tab) : "/settings/advanced";
}
