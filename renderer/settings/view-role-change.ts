// Changing what a view is for changes every screen showing it, so the operator
// is told which screens before it happens.
//
// The server makes the whole change as one rolled-back call (POST
// /api/views/:id/surface); this is the question asked first, and asked again
// when the server says the screens changed while it was open. A function
// rather than a few lines in the settings hook so that what it asks, and that
// declining sends nothing, are driven rather than read off the source.

import { outputMode, surfaceForMode, type ViewSurface } from "@main/types/views";
import type { StageState } from "@main/types/stage";
import type { ConfirmOptions } from "../components/ui";
import type { ApiError } from "../lib/api";

/** "A", "A and B", "A, B and C". */
function nameList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One screen a change would make: the id the server is sent, the name the
 *  operator is shown. */
export interface ChangedScreen {
  id: string;
  name: string;
}

/**
 * The screens that showing `viewId` as `surface` would change: the ones whose
 * role does not already match. A screen already as asked is not named, because
 * nothing happens to it.
 */
export function screensChangedBy(state: Pick<StageState, "outputs"> | undefined, viewId: string, surface: ViewSurface): ChangedScreen[] {
  return (state?.outputs ?? [])
    .filter((o) => o.viewId === viewId && surfaceForMode(outputMode(o)) !== surface)
    .map((o) => ({ id: o.id, name: o.name || o.id }));
}

/** What to ask before changing these screens, or null when there is none to
 *  ask about. `again` says the list changed since the operator was last asked. */
export function viewRoleQuestion(
  viewName: string,
  surface: ViewSurface,
  screens: string[],
  { again = false }: { again?: boolean } = {},
): ConfirmOptions | null {
  if (screens.length === 0) return null;
  const one = screens.length === 1;
  const names = nameList(screens);
  const lead = again ? "The screens showing it changed while you were deciding. " : "";
  return surface === "console"
    ? {
        title: `Make "${viewName}" a control surface?`,
        message: lead + (one
          ? `${names} will become a control surface. Anyone at it can press its buttons.`
          : `${names} will become control surfaces. Anyone at them can press their buttons.`),
        confirmLabel: one ? "Make it a control surface" : "Make them control surfaces",
      }
    : {
        title: `Make "${viewName}" a wall display?`,
        message: lead + (one
          ? `${names} will become a wall display. Its buttons will stop working.`
          : `${names} will become wall displays. Their buttons will stop working.`),
        confirmLabel: one ? "Make it a wall display" : "Make them wall displays",
      };
}

/** The screens a 409 `screens-changed` says would change now, or null for any
 *  other failure. */
export function screensNowChanged(err: unknown): ChangedScreen[] | null {
  const e = err as ApiError | undefined;
  if (e?.code !== "screens-changed" || !Array.isArray(e.body?.screens)) return null;
  return (e.body.screens as unknown[]).flatMap((s) => {
    const { id, name } = (s ?? {}) as { id?: unknown; name?: unknown };
    return typeof id === "string" ? [{ id, name: typeof name === "string" && name ? name : id }] : [];
  });
}

/**
 * Ask which screens would change, if any, and send the change with the ids of
 * the screens asked about, unless declined. Answers whether it was sent;
 * declining changes nothing and sends nothing.
 *
 * The server compares the ids with the screens it would change, and refuses
 * with 409 `screens-changed` when somebody pointed a screen at the view, or away
 * from it, while the question was open. Then the operator is asked once more
 * with the list as the server has it, and that is sent. A second refusal, or any
 * other failure, is thrown to the caller.
 */
export async function changeViewRole(args: {
  /** The state as it is NOW, read by the caller at click time. */
  state: Pick<StageState, "views" | "outputs"> | undefined;
  viewId: string;
  surface: ViewSurface;
  ask: (question: ConfirmOptions) => Promise<boolean>;
  /** Send the change, naming the screens the operator agreed to. Throws on failure. */
  send: (screens: string[]) => Promise<unknown>;
}): Promise<boolean> {
  const { state, viewId, surface, ask, send } = args;
  const viewName = state?.views.find((v) => v.id === viewId)?.name ?? "This view";
  const askThenSend = async (screens: ChangedScreen[], again: boolean): Promise<boolean> => {
    const question = viewRoleQuestion(viewName, surface, screens.map((s) => s.name), { again });
    if (question && !(await ask(question))) return false;
    await send(screens.map((s) => s.id));
    return true;
  };
  try {
    return await askThenSend(screensChangedBy(state, viewId, surface), false);
  } catch (err) {
    const now = screensNowChanged(err);
    if (!now) throw err;
    return askThenSend(now, true);
  }
}
