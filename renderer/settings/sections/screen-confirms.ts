// The two questions the Screens page asks before it destroys something, written
// once. Removing a screen is asked from two places (a card's menu and the panel's
// footer) and deleting a view from three (a view card's menu, the layout editor's
// header and the View settings footer), and three copies of a confirm are how
// their wording drifts apart.

import { confirm, confirmWith, toast } from "../../components/ui";
import type { SectionHandlers } from "../types";
import { listNames } from "./screen-panel-parts";

/**
 * Ask before a view is deleted. A view's layout cannot be got back, and every
 * screen showing it is left with nothing: so they are named. `shownOn` is the
 * screens that show it now.
 */
export function confirmDeleteView(view: Pick<View, "name">, shownOn: readonly Pick<Output, "name">[]): Promise<boolean> {
  return confirm({
    title: `Delete view "${view.name}"?`,
    message: "Its layout goes with it. This cannot be undone.",
    note: shownOn.length
      ? `${listNames(shownOn.map((o) => o.name))} ${shownOn.length > 1 ? "show" : "shows"} it, and will show nothing until you pick another view.`
      : undefined,
    confirmLabel: "Delete view",
    destructive: true,
  });
}

/** The screens other than `output` that show a view. */
function othersShowing(outputs: readonly Output[], output: Output, viewId: string): Output[] {
  return outputs.filter((o) => o.id !== output.id && o.viewId === viewId);
}

/**
 * Remove a screen, asking first, and with it its view if the operator says so.
 *
 * The question offers the view only when no other screen shows it: deleting a
 * view somebody else is showing would blank their screen. Left unticked (the
 * default) the view survives under "Views not on a screen". When the screen is
 * shared, the dialog says which others keep the view alive.
 *
 * Removing both is two writes, the screen first. If the second fails the
 * operator is told the screen is gone and the view is not: neither failure is
 * swallowed, and a view that was never deleted is not reported as deleted.
 *
 * `latest` reads the state as it is NOW, after the question was answered: another
 * operator may have put the view on a second screen while the dialog was open,
 * and the box was ticked on the strength of "nothing else shows it".
 *
 * Resolves whether the screen was removed.
 */
export async function removeScreen({ output, state, latest, handlers }: {
  output: Output;
  state: { outputs: readonly Output[]; views: readonly View[] };
  latest: () => { outputs: readonly Output[] };
  handlers: Pick<SectionHandlers, "handleRemoveOutput" | "handleRemoveView">;
}): Promise<boolean> {
  const view = output.viewId ? state.views.find((v) => v.id === output.viewId) : undefined;
  const others = view ? othersShowing(state.outputs, output, view.id) : [];
  const alone = view !== undefined && others.length === 0;

  const answer = await confirmWith({
    title: `Remove "${output.name}"?`,
    message: "Its address and settings go away. This cannot be undone.",
    note: view && !alone
      ? `Its view, "${view.name}", stays: ${listNames(others.map((o) => o.name))} also ${others.length > 1 ? "show" : "shows"} it.`
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

  const sharedNow = othersShowing(latest().outputs, output, view.id);
  if (sharedNow.length > 0) {
    toast.error(`Removed "${output.name}". Its view "${view.name}" was kept: ${listNames(sharedNow.map((o) => o.name))} now ${sharedNow.length > 1 ? "show" : "shows"} it.`);
    return true;
  }
  if (!(await handlers.handleRemoveView(view.id))) {
    toast.error(`Removed "${output.name}", but its view "${view.name}" was not deleted. It is under Views not on a screen.`);
  }
  return true;
}
