// The question asked before a screen becomes what it is not, written once for the
// screen card's view picker and the Screen settings panel.
//
// Making a screen a control surface makes its buttons live to anyone standing at
// it, which is not something to do by misclick, and making it a wall display
// switches them off.

import { confirm } from "../components/ui";
import { screenIsControlSurface, viewSurface, type ViewSurface } from "@main/types/views";

/**
 * What each surface is, in the words the panel, the cards and the questions all
 * use. `title` names it, `hint` says what it means for the buttons, and `becomes`
 * is what happens to a screen when it turns into one.
 */
export const SURFACE_COPY: Record<ViewSurface, { title: string; hint: string; becomes: string }> = {
  console: {
    title: "Control surface",
    hint: "Its buttons work for anyone at it.",
    becomes: "Its buttons will work. Anyone standing at it can press them.",
  },
  display: {
    title: "Wall display",
    hint: "Read-only. Buttons draw but do nothing.",
    becomes: "It becomes read-only. Its buttons will render but do nothing.",
  },
};

/** "a control surface" / "a wall display", for a sentence. */
export const surfaceNoun = (surface: ViewSurface): string => `a ${SURFACE_COPY[surface].title.toLowerCase()}`;

/** The title of the question asked before `name` becomes `surface`. One wording
 *  for a screen changing because of the view it was pointed at and for a view
 *  being changed under the screens showing it. */
export const roleQuestionTitle = (name: string, surface: ViewSurface): string => `Make "${name}" ${surfaceNoun(surface)}?`;

/** The confirm button of that question; `many` when several screens change. */
export const roleQuestionLabel = (surface: ViewSurface, many = false): string =>
  many ? `Make them ${SURFACE_COPY[surface].title.toLowerCase()}s` : `Make it ${surfaceNoun(surface)}`;

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
  const what = SURFACE_COPY[becomes].becomes;
  return confirm({
    title: roleQuestionTitle(name, becomes),
    message: why ? `${why} ${what}` : what,
    confirmLabel: roleQuestionLabel(becomes),
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

