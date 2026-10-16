// Choosing a view for a screen, and the question asked before a screen or a view
// becomes what it is not. Written once for the card's picker, the panel's, and the
// view-kind switch.

import { confirm } from "../components/ui";
import { screenIsControlSurface, viewSurface, type ViewSurface } from "@main/types/views";

/** The view-picker values that are not a view: clear the choice, or make a new one
 *  of this kind. Never stored. */
export const NONE = "__none__";
export const NEW_WALL = "__new_wall__";
export const NEW_CONTROL = "__new_control__";

/**
 * The kind of view `viewId` is, as the operator saw it: what to send as
 * `expectSurface` after they confirm a screen going live on it. Read from the
 * views the confirm was asked against, never from a fresher copy: the point is
 * that the server refuses when the view changed while the question was open.
 * Undefined for a view that is not there, which sends no expectation.
 */
export function expectedSurface(views: readonly Pick<View, "id" | "surface">[], viewId: string): ViewSurface | undefined {
  const view = views.find((v) => v.id === viewId);
  return view ? viewSurface(view) : undefined;
}

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
async function confirmRole(screenName: string, becomes: ViewSurface, viewName: string): Promise<boolean> {
  const live = becomes === "console";
  return confirm({
    title: roleQuestionTitle(screenName, becomes, "screen"),
    message: live
      ? `"${viewName}" is a control surface. Buttons on this screen will work, and anyone standing at it can press them.`
      : `"${viewName}" is a wall view. This screen becomes read-only: its buttons will draw but do nothing.`,
    confirmLabel: live ? "Show it and make it live" : "Show it",
  });
}

/** Would showing a view of kind `becomes` change what the screen is? */
function changesRole(output: Output, views: readonly View[], becomes: ViewSurface): boolean {
  return (becomes === "console") !== screenIsControlSurface(output, views);
}

/**
 * Pointing a screen at a view is also choosing what the screen is. Asks when that
 * changes it (the view is of the other kind than the screen shows now) and says
 * whether to go ahead. A view of the kind the screen already shows asks nothing.
 */
async function confirmViewKind(output: Output, views: readonly View[], viewId: string): Promise<boolean> {
  const picked = views.find((v) => v.id === viewId);
  if (!picked) return true;
  const becomes = viewSurface(picked);
  if (!changesRole(output, views, becomes)) return true;
  return confirmRole(output.name, becomes, picked.name);
}

/** What a picker's choice does to a screen. */
interface ScreenChoice {
  output: Output;
  views: readonly View[];
  /** Point the screen at a view, or none. `expectSurface` is the kind it was asked about. */
  setView: (viewId: string | null, expectSurface?: ViewSurface) => void;
}

/**
 * Act on a view picker's value for a screen: a new view of a kind (asked for from
 * the caller), none, or an existing view, which is asked about first when it is the
 * other kind than the screen shows. Declining changes nothing. The card's picker and
 * the panel's are this one function.
 */
export async function chooseViewForScreen({ output, views, value, setView, requestNewView }: ScreenChoice & {
  value: string;
  requestNewView: (surface: ViewSurface) => void;
}): Promise<void> {
  if (value === NEW_WALL) requestNewView("display");
  else if (value === NEW_CONTROL) requestNewView("console");
  else if (value === NONE) setView(null);
  else if (await confirmViewKind(output, views, value)) setView(value, expectedSurface(views, value));
}

/**
 * Point a screen at a view just made for it. Its kind is known, and when it is not
 * the kind the screen shows the operator is asked first, as for any view.
 */
export async function assignMadeView({ output, views, made, setView }: ScreenChoice & {
  made: { id: string; name: string; surface: ViewSurface };
}): Promise<void> {
  if (changesRole(output, views, made.surface) && !(await confirmRole(output.name, made.surface, made.name))) return;
  setView(made.id, made.surface);
}
