// What the layouts editor says about a layout's name: a free one for a new layout.

import { firstFreeNumbered } from "@main/services/first-free";
import { layoutNameKey } from "@main/services/servicecue-slug";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

/** "Layout 1", "Layout 2" … the first no existing layout is called, in the sense the
 *  server compares names (layoutNameKey). Counting layouts instead would hand out a
 *  name already taken once one in the middle has been deleted. */
export function freeLayoutName(layouts: ServiceCueLayout[]): string {
  const taken = new Set(layouts.map((l) => layoutNameKey(l.name)));
  return firstFreeNumbered("Layout", (s) => taken.has(layoutNameKey(s)), layouts.length + 1);
}
