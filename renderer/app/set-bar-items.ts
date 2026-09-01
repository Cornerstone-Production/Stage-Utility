// Saving the context bar's arrangement.
//
// Its own module because there are two ways in — the configurator opened from
// the bar's own right-click menu, and the one opened from Advanced. The
// optimistic-update-then-roll-back dance itself lives in lib/optimistic.

import type { QueryClient } from "@tanstack/react-query";

import { invoke } from "../lib/api";
import { writeOptimistic } from "../lib/optimistic";

/** Which of the two sets a save is for. */
export type BarSet = "desktop" | "mobile";

/**
 * Write one of the bar's two orders, showing it immediately and putting it back
 * if the server refuses.
 *
 * ONE SET PER CALL, and the other is not sent at all. Sending both would mean
 * echoing back whatever this client last read for the set it is not editing —
 * so a phone saving its own strip would silently revert a desktop edit made
 * seconds earlier on another machine. The server leaves an absent list alone.
 *
 * Returns whether it saved. The bar is global config, so a caller that closed a
 * dialog on the strength of a failed write would leave two operators looking at
 * different bars.
 */
export async function setBarItems(
  queryClient: QueryClient,
  set: BarSet,
  items: string[],
): Promise<boolean> {
  const key = set === "mobile" ? "barMobileItems" : "barItems";
  const next = await writeOptimistic<StageState>(
    queryClient,
    ["stage:getState"],
    (cur) => ({ ...cur, [key]: items }),
    () => invoke<StageState>("barItems:set", set === "mobile" ? { mobileItems: items } : { items }),
  );
  return next != null;
}
