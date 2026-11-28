// Listing a console in the sidebar, or keeping it out.
//
// The view's own `showInSidebar` switch, written from Screens and from the
// sidebar's Hide and tray alike: one setting, so the two cannot disagree about
// whether a console is hidden.

import type { QueryClient } from "@tanstack/react-query";

import { invoke } from "../lib/api";
import { QUERY_KEYS } from "./queries";
import { writeOptimistic } from "../lib/optimistic";

/** Optimistic: the server refuses only an id that does not exist, and a switch
 *  has to follow the operator's finger. Resolves whether it saved. */
export async function setViewShowInSidebar(queryClient: QueryClient, id: string, showInSidebar: boolean): Promise<boolean> {
  const next = await writeOptimistic<StageState>(
    queryClient,
    QUERY_KEYS.stageState,
    (cur) => ({ ...cur, views: cur.views.map((v) => (v.id === id ? { ...v, showInSidebar } : v)) }),
    () => invoke<StageState>("views:setShowInSidebar", { id, showInSidebar }),
    "Failed to change whether the console is listed in the sidebar",
  );
  return next != null;
}
