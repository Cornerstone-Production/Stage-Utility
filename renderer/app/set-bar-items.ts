// Saving the context bar's arrangement.
//
// Its own module because there are two ways in — the configurator opened from
// the bar's own right-click menu, and the one opened from Advanced. The
// optimistic-update-then-roll-back dance itself lives in lib/optimistic.

import type { QueryClient } from "@tanstack/react-query";

import { invoke } from "../lib/api";
import { writeOptimistic } from "../lib/optimistic";

/**
 * Write the bar's order, showing it immediately and putting it back if the
 * server refuses.
 *
 * Returns whether it saved. The bar is global config, so a caller that closed a
 * dialog on the strength of a failed write would leave two operators looking at
 * different bars.
 */
export async function setBarItems(queryClient: QueryClient, items: string[]): Promise<boolean> {
  const next = await writeOptimistic<StageState>(
    queryClient,
    ["stage:getState"],
    (cur) => ({ ...cur, barItems: items }),
    () => invoke<StageState>("barItems:set", { items }),
  );
  return next != null;
}
