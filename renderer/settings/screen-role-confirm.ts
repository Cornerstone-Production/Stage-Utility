// The question asked before a screen becomes what it is not, written once for the
// screen card's view picker and the Screen settings panel.
//
// Making a screen a control surface makes its buttons live to anyone standing at
// it, which is not something to do by misclick, and making it a wall display
// switches them off.

import { confirm } from "../components/ui";
import { screenIsControlSurface, viewSurface, type ViewSurface } from "@main/types/views";

/**
 * Ask before a screen becomes what it is not. The one confirm for it, here and on
 * the screen card's view picker, so the title and the button are written once.
 *
 * Making a screen a control surface makes its buttons live to anyone standing at
 * it, which is not something to do by misclick, and making it a wall display
 * switches them off. `why` leads the message when the change is a consequence of
 * something else the operator chose.
 */
export async function confirmRole(name: string, becomes: ViewSurface, why?: string): Promise<boolean> {
  const toConsole = becomes === "console";
  const what = toConsole
    ? "Its buttons will work. Anyone standing at it can press them."
    : "It becomes read-only. Its buttons will render but do nothing.";
  return confirm({
    title: toConsole ? `Make "${name}" a control surface?` : `Make "${name}" a wall display?`,
    message: why ? `${why} ${what}` : what,
    confirmLabel: toConsole ? "Make it a control surface" : "Make it a wall display",
  });
}

/**
 * Pointing a screen at a view is also choosing what the screen is. Asks when that
 * changes it (the view is of the other kind than the screen shows now) and says
 * whether to go ahead. A view of the kind the screen already shows asks nothing.
 */
export async function confirmViewKind(output: Output, views: readonly View[], viewId: string): Promise<boolean> {
  const picked = views.find((v) => v.id === viewId);
  if (!picked) return true;
  const becomes = viewSurface(picked);
  if ((becomes === "console") === screenIsControlSurface(output, views)) return true;
  return confirmRole(output.name, becomes, `"${picked.name}" is ${becomes === "console" ? "a control surface" : "a wall view"}.`);
}

