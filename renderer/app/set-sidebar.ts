// Saving the sidebar's arrangement.
//
// Its own module because there are several ways in: Customize mode, and Hide
// and Move to on a page's right-click menu. The optimistic-update-then-roll-back
// dance itself lives in lib/optimistic.

import type { QueryClient } from "@tanstack/react-query";
import type { SidebarArrangement } from "@main/services/sidebar-arrangement";

import { invoke } from "../lib/api";
import { writeOptimistic } from "../lib/optimistic";

/**
 * Write the arrangement, showing it at once and putting it back if the server
 * refuses. The refusal is shown in a toast, in the server's words.
 *
 * Returns whether it saved. The rail draws from the live SSE state, which a
 * refused write never reaches, so a caller holding a draft re-seeds it from the
 * saved arrangement when this says false.
 */
export async function setSidebar(queryClient: QueryClient, arrangement: SidebarArrangement): Promise<boolean> {
  const next = await writeOptimistic<StageState>(
    queryClient,
    ["stage:getState"],
    (cur) => ({ ...cur, sidebar: arrangement }),
    () => invoke<StageState>("sidebar:set", { ...arrangement }),
  );
  return next != null;
}
