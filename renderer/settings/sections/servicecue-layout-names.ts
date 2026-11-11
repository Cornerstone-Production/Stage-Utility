// What the layouts editor says about deleting a layout: which screens would fall back to
// All columns.

import type { ServiceCueLayout } from "../../../main/types/pco.js";

/** The delete confirm's text. `views` is null until the stage state has arrived, and
 *  then nothing is claimed about who uses the layout. */
export function usersMessage(
  layout: Pick<ServiceCueLayout, "id">,
  views: readonly { name: string; serviceCueLayoutId?: string | null }[] | null | undefined,
): string {
  if (!views) return "Screens using it will show all columns instead.";
  const users = views.filter((v) => v.serviceCueLayoutId === layout.id).map((v) => v.name);
  // "Display", not "screen": a tablet pinned to the address by URL is set to nothing
  // the server knows of, so this cannot speak for it.
  if (users.length === 0) return "No display is set to it.";
  return `Used by ${users.join(", ")}. ${users.length === 1 ? "It" : "They"} will show all columns instead.`;
}
