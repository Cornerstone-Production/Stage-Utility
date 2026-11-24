// Saving the sidebar's arrangement.
//
// Its own module because there are several ways in: Customize mode, and Hide
// and Move to on a page's right-click menu. The arrangement is one value the
// server holds whole, saved one change at a time through use-saved-list.ts as a
// list of one; this is how it reaches the server.

import type { QueryClient } from "@tanstack/react-query";
import { EMPTY_SIDEBAR, type SidebarArrangement } from "@main/services/sidebar-arrangement";

import { invoke } from "../lib/api";
import type { ListIo } from "../lib/use-list-saves";

const arrangementOf = (state: StageState): SidebarArrangement[] => [state.sidebar ?? EMPTY_SIDEBAR];

/**
 * How the arrangement reaches the server, for use-saved-list. Memoise it per
 * query client. A refusal throws in the server's words; the caller says it.
 */
export function sidebarListIo(queryClient: QueryClient): ListIo<SidebarArrangement> {
  return {
    save: async ([arrangement]) => {
      const next = await invoke<StageState>("sidebar:set", { ...arrangement });
      queryClient.setQueryData(["stage:getState"], next);
      return arrangementOf(next);
    },
    read: async () => {
      const next = await invoke<StageState>("stage:getState");
      queryClient.setQueryData(["stage:getState"], next);
      return arrangementOf(next);
    },
  };
}

export { arrangementOf };
