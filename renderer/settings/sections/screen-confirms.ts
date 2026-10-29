// Asking before a screen is removed or a view is deleted, and doing it: removeScreen
// (with its view, if the operator says so) and deleteView. Each is offered from more
// than one place, so each is one function.

import { screenName, screensShowing, viewIsConsole } from "@main/types/views";
import { confirm, confirmWith, toast } from "../../components/ui";
import type { SectionHandlers } from "../types";
import { listNames } from "../screen-role-confirm";
import { forEachSlotsGrid } from "@main/services/slot-boards";

/** "A shows it" / "A and B show it", for a note naming screens. */
const showVerb = (screens: readonly unknown[]): string => (screens.length > 1 ? "show" : "shows");

/**
 * Ask before a view is deleted. A view's layout cannot be got back, and every
 * screen showing it is left with nothing: so they are named. A control surface's
 * screens were live, and say so.
 */
function confirmDeleteView(view: Pick<View, "name" | "surface">, shownOn: readonly Pick<Output, "id" | "name">[]): Promise<boolean> {
  const note = shownOn.length
    ? `${listNames(shownOn.map(screenName))} ${showVerb(shownOn)} it, and will show nothing until you pick another view.` +
      (viewIsConsole(view) ? ` ${shownOn.length > 1 ? "Their" : "Its"} buttons stop working.` : "")
    : undefined;
  return confirm({
    title: `Delete view "${view.name}"?`,
    message: "Its layout goes with it. This cannot be undone.",
    note,
    confirmLabel: "Delete view",
    destructive: true,
  });
}

/** Ask, then delete a view. Resolves whether it is gone. */
export async function deleteView({ view, outputs, handlers }: {
  view: View;
  outputs: readonly Output[];
  handlers: Pick<SectionHandlers, "handleRemoveView">;
}): Promise<boolean> {
  if (!(await confirmDeleteView(view, screensShowing(view.id, outputs)))) return false;
  return (await handlers.handleRemoveView(view.id)).removed;
}

/**
 * Remove a screen, asking first, and with it its view if the operator says so.
 *
 * The question offers the view only when no other screen shows it. Left unticked
 * (the default) the view survives under "Views not on a screen"; when other
 * screens show it the dialog names them and the view stays.
 *
 * Removing both is two writes, the screen first. The second asks the server to
 * delete the view only if no screen shows it: another operator may have pointed a
 * screen at it while the dialog was open, and the server, not this page's copy of
 * the state, is what knows. A refusal is told as it is (the screen is gone, the
 * view is kept, and which screen shows it), and so is a failure.
 *
 * `state` is the screens and views as they are when the screen is asked about; the
 * server, not this copy, decides about the view afterwards. Resolves whether the
 * screen was removed.
 */
export async function removeScreen({ output, state, handlers }: {
  output: Output;
  state: { outputs: readonly Output[]; views: readonly View[] };
  handlers: Pick<SectionHandlers, "handleRemoveOutput" | "handleRemoveView">;
}): Promise<boolean> {
  const { outputs, views } = state;
  const view = output.viewId ? views.find((v) => v.id === output.viewId) : undefined;
  const others = view ? screensShowing(view.id, outputs).filter((o) => o.id !== output.id) : [];
  const alone = view !== undefined && others.length === 0;

  const answer = await confirmWith({
    title: `Remove "${output.name}"?`,
    message: "Its address and settings go away. This cannot be undone.",
    note: view && !alone
      ? `Its view, "${view.name}", stays: ${listNames(others.map(screenName))} also ${showVerb(others)} it.`
      : undefined,
    checkbox: alone
      ? {
          label: `Also delete its view, "${view.name}"`,
          detail: "Nothing else shows it. Left unticked, it moves to Views not on a screen.",
          confirmLabel: "Remove screen and view",
        }
      : undefined,
    confirmLabel: "Remove screen",
    destructive: true,
  });
  if (!answer.ok) return false;

  if (!(await handlers.handleRemoveOutput(output.id))) return false;
  if (!answer.checked || !view) return true;

  const outcome = await handlers.handleRemoveView(view.id, { ifUnshown: true });
  if (outcome.removed) return true;
  toast.error(
    outcome.shownOn
      ? `Removed "${output.name}". Its view "${view.name}" was kept: ${listNames(outcome.shownOn)} now ${showVerb(outcome.shownOn)} it.`
      : `Removed "${output.name}", but its view "${view.name}" was not deleted. It is under Views not on a screen.`,
  );
  return true;
}

/** Does this view show any mic slot board: a slots screen, or a custom layout with
 *  a slots widget? */
export function showsBoards(view: View): boolean {
  if (view.kind === "slots") return true;
  let found = false;
  forEachSlotsGrid([view], () => {
    found = true;
  });
  return found;
}

/**
 * Ask how a duplicate of a view treats its mic slot boards. Null when the operator
 * backs out; otherwise whether the copy gets boards of its own.
 *
 * A view that shows no board has nothing to ask, and its copy gets none either way.
 * The default is a copy with its own boards, so editing the copy cannot change the
 * original's slots; sharing is the choice to make, with the box.
 */
export async function askDuplicateView(view: View): Promise<{ copyBoards: boolean } | null> {
  if (!showsBoards(view)) return { copyBoards: false };
  const { ok, checked } = await confirmWith({
    title: `Duplicate "${view.name}"?`,
    message: "The copy gets its own copy of each mic slot board this view shows, so changing one does not change the other.",
    confirmLabel: "Duplicate",
    checkbox: {
      label: "Share the same boards instead",
      detail: "The copy and the original then show, and edit, the same boards.",
    },
  });
  return ok ? { copyBoards: !checked } : null;
}
