// The question asked before a screen becomes what it is not, written once for the
// screen card's view picker and the Screen settings panel.
//
// Making a screen a control surface makes its buttons live to anyone standing at
// it, which is not something to do by misclick, and making it a wall display
// switches them off.

import { confirm } from "../components/ui";
import { screenIsControlSurface, viewSurface, type ViewSurface } from "@main/types/views";

/**
 * What each surface is, in the words the panels and the questions use. `title`
 * names it (for a screen), `hint` is the one line under a screen's view picker, and
 * `card` is the longer sentence on a view's kind card.
 */
export const SURFACE_COPY: Record<ViewSurface, { title: string; hint: string; card: string }> = {
  console: {
    title: "Control surface",
    hint: "Its buttons work for anyone at it.",
    card: "Its buttons work, in the sidebar and on any screen showing it.",
  },
  display: {
    title: "Wall display",
    hint: "Read-only. Buttons draw but do nothing.",
    card: "Read from across the room. Buttons draw but do nothing.",
  },
};

/** Names, quoted, for a sentence: one, two joined by "and", three or more
 *  separated by commas. */
export function listNames(names: readonly string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  return quoted.join(quoted.length > 2 ? ", " : " and ");
}

/** The title of the question asked before `name` becomes `surface`. A screen
 *  becomes a control surface or a wall display; a view, a control surface or a
 *  wall view. */
export const roleQuestionTitle = (name: string, surface: ViewSurface, subject: "screen" | "view"): string =>
  `Make "${name}" ${surface === "console" ? "a control surface" : subject === "screen" ? "a wall display" : "a wall view"}?`;

/** The confirm button of the question asked about a view. */
export const viewKindLabel = (surface: ViewSurface): string => (surface === "console" ? "Make it a control surface" : "Make it a wall view");

/**
 * Ask before a screen becomes what it is not: pointed at a view of the other kind.
 * Making a screen a control surface makes its buttons live to anyone standing at
 * it, which is not something to do by misclick, and making it a wall display
 * switches them off.
 */
export async function confirmRole(screenName: string, becomes: ViewSurface, viewName: string): Promise<boolean> {
  const live = becomes === "console";
  return confirm({
    title: roleQuestionTitle(screenName, becomes, "screen"),
    message: live
      ? `"${viewName}" is a control surface. Buttons on this screen will work, and anyone standing at it can press them.`
      : `"${viewName}" is a wall view. This screen becomes read-only: its buttons will draw but do nothing.`,
    confirmLabel: live ? "Show it and make it live" : "Show it",
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
  return confirmRole(output.name, becomes, picked.name);
}

