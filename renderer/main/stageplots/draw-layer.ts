// draw-layer.ts — which layer an item is drawn in. Shared by the drawing
// (plot-items.tsx, also on the published page) and the editor's Arrange, which
// moves an item only among the items of its own layer.

import type { PlotItem } from "@main/types/stageplots";

/** Draw order layer: zones under shapes under cables under symbols and connection points under text. */
export function layer(it: Pick<PlotItem, "type">): number {
  if (it.type === "zone") return 0;
  if (it.type === "box" || it.type === "circle") return 1;
  if (it.type === "cable") return 2;
  if (it.type === "text") return 4;
  return 3;
}
