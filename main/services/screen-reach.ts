// screen-reach.ts — which views a screen actually draws.
//
// A screen (an output) draws the view it is routed to, and whatever that view
// embeds: another view through a view-embed tile, or another screen's view through
// a screen-embed tile, and so on down. Answering a stage message from a Messages
// widget is allowed only for a screen that draws that widget, so this is what the
// reply check asks. Pure: it reads the settings it is handed and nothing else.

import type { Output, View } from "../types/views.js";
import { scrub } from "./scrub.js";
import { walkLayoutObjects } from "./view-refs.js";

/**
 * The most views one walk will visit. A real wall nests a handful; past this it is
 * a loop the seen set failed to cut or a layout nobody drew, and a reply check must
 * answer rather than spin. Hitting it is said on the log and the walk stops there.
 */
export const MAX_VIEWS_VISITED = 256;

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
  let visited = 0;
  while (queue.length > 0) {
    if (++visited > MAX_VIEWS_VISITED) {
      console.warn(`[messages] the views screen ${scrub(output.id)} draws run past ${MAX_VIEWS_VISITED}; stopped looking for the widget there`);
      break;
    }
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
