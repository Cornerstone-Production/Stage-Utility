// Where the editing chrome may appear.
//
// One decision, in one place, reusing Phase 3's context gate rather than
// inventing a second rule. The chrome is not "disabled" outside the shell — it
// does not mount at all, because a disabled toolbar on a wall screen is still a
// toolbar someone will wonder about.

import { layoutEditingLive, type RenderContext } from "../main/render-context";
import { viewSurface } from "@main/types/views";

/**
 * Whether a view can be edited in place, in this context.
 *
 * Two conditions, both required:
 *  - the context allows editing at all (shell only — see render-context.ts)
 *  - the view is a console; a display's layout is edited on its own page, where
 *    there is no live surface to overlay
 */
export function canEditInPlace(view: Pick<View, "surface">, ctx: RenderContext): boolean {
  return layoutEditingLive(ctx) && viewSurface(view) === "console";
}
