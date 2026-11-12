// What the layouts editor says about a layout's name: a free one for a new layout, and
// which screens a delete would send back to All columns.

import { layoutNameKey } from "@main/services/servicecue-slug";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

/** "Layout 1", "Layout 2" … the first no existing layout is called, in the sense the
 *  server compares names (layoutNameKey). Counting layouts instead would hand out a
 *  name already taken once one in the middle has been deleted. */
export function freeLayoutName(layouts: ServiceCueLayout[]): string {
  const taken = new Set(layouts.map((l) => layoutNameKey(l.name)));
  let n = layouts.length + 1;
  while (taken.has(layoutNameKey(`Layout ${n}`))) n++;
  return `Layout ${n}`;
}

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
