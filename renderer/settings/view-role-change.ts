// Changing what a view is for changes every screen showing it, so the operator
// is told which screens before it happens.
//
// The server makes the whole change as one rolled-back call (POST
// /api/views/:id/surface); this is only the question asked first. A function
// rather than a few lines in the settings hook so that what it asks, and that
// declining sends nothing, are driven rather than read off the source.

import { outputMode, surfaceForMode, type ViewSurface } from "@main/types/views";
import type { StageState } from "@main/types/stage";
import type { ConfirmOptions } from "../components/ui";

/** "A", "A and B", "A, B and C". */
function nameList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The names of the screens that showing `viewId` as `surface` would change: the
 * ones whose role does not already match. A screen already as asked is not
 * named, because nothing happens to it.
 */
export function screensChangedBy(state: Pick<StageState, "outputs"> | undefined, viewId: string, surface: ViewSurface): string[] {
  return (state?.outputs ?? [])
    .filter((o) => o.viewId === viewId && surfaceForMode(outputMode(o)) !== surface)
    .map((o) => o.name || o.id);
}

/** What to ask before changing these screens, or null when there is none to ask about. */
export function viewRoleQuestion(viewName: string, surface: ViewSurface, screens: string[]): ConfirmOptions | null {
  if (screens.length === 0) return null;
  const one = screens.length === 1;
  const names = nameList(screens);
  return surface === "console"
    ? {
        title: `Make "${viewName}" a control surface?`,
        message: one
          ? `${names} will become a control surface. Anyone at it can press its buttons.`
          : `${names} will become control surfaces. Anyone at them can press their buttons.`,
        confirmLabel: one ? "Make it a control surface" : "Make them control surfaces",
      }
    : {
        title: `Make "${viewName}" a wall display?`,
        message: one
          ? `${names} will become a wall display. Its buttons will stop working.`
          : `${names} will become wall displays. Their buttons will stop working.`,
        confirmLabel: one ? "Make it a wall display" : "Make them wall displays",
      };
}

/**
 * Ask which screens would change, if any, and send the change unless declined.
 * Answers whether it was sent and succeeded; declining changes nothing and
 * sends nothing.
 */
export async function changeViewRole(args: {
  /** The state as it is NOW, read by the caller at click time. */
  state: Pick<StageState, "views" | "outputs"> | undefined;
  viewId: string;
  surface: ViewSurface;
  ask: (question: ConfirmOptions) => Promise<boolean>;
  send: () => Promise<boolean>;
}): Promise<boolean> {
  const { state, viewId, surface, ask, send } = args;
  const view = state?.views.find((v) => v.id === viewId);
  const question = viewRoleQuestion(view?.name ?? "This view", surface, screensChangedBy(state, viewId, surface));
  if (question && !(await ask(question))) return false;
  return send();
}
