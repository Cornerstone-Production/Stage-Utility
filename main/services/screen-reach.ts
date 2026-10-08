// screen-reach.ts — which views a screen actually draws.
//
// A screen (an output) draws the view it is routed to, and whatever that view
// embeds: another view through a view-embed tile, or another screen's view through
// a screen-embed tile, and so on down. Answering a stage message from a Messages
// widget is allowed only for a screen that draws that widget, so this is what the
// reply check asks. Pure: it reads the settings it is handed and nothing else.

import type { Output, View } from "../types/views.js";
import { walkLayoutObjects } from "./view-refs.js";

/**
 * The ids of every view `output` draws: its routed view and everything reached
 * from it through view-embed and screen-embed tiles. Empty for a screen routed to
 * nothing. A cycle (a view embedding itself, two screens embedding each other) is
 * cut by the seen set, so it terminates.
 */
export function viewsDrawnBy(output: Output, views: readonly View[], outputs: readonly Output[]): Set<string> {
  const seen = new Set<string>();
  const byId = new Map(views.map((v) => [v.id, v]));
  const queue = output.viewId ? [output.viewId] : [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const view = byId.get(id);
    if (!view?.layout) continue;
    walkLayoutObjects(view.layout.objects, (o) => {
      const c = o.config;
      if (c.type === "view-embed" && c.viewId) queue.push(c.viewId);
      if (c.type === "screen-embed" && c.outputId) {
        const target = outputs.find((x) => x.id === c.outputId);
        if (target?.viewId) queue.push(target.viewId);
      }
    });
  }
  return seen;
}
