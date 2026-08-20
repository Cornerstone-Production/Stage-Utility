// Saving the context bar's arrangement.
//
// Its own module because there are two ways in — the configurator opened from
// the bar's own right-click menu, and the one opened from Advanced — and a
// second copy of the optimistic-update-then-roll-back dance is a second place
// for a failed save to read as saved.

import type { QueryClient } from "@tanstack/react-query";

import { invoke } from "../lib/api";
import { toast } from "../components/ui";
import { errorMessage } from "@main/services/errors";

/**
 * Write the bar's order, showing it immediately and putting it back if the
 * server refuses.
 *
 * Returns whether it saved. The bar is global config, so a caller that closed a
 * dialog on the strength of a failed write would leave two operators looking at
 * different bars.
 */
export async function setBarItems(queryClient: QueryClient, items: string[]): Promise<boolean> {
  const prev = queryClient.getQueryData<StageState>(["stage:getState"]);
  if (prev) queryClient.setQueryData(["stage:getState"], { ...prev, barItems: items });
  try {
    const next = await invoke<StageState>("barItems:set", { items });
    queryClient.setQueryData(["stage:getState"], next);
    return true;
  } catch (err) {
    // Put the old order back rather than leaving the UI showing a bar the
    // server does not have.
    if (prev) queryClient.setQueryData(["stage:getState"], prev);
    toast.error(errorMessage(err));
    return false;
  }
}
