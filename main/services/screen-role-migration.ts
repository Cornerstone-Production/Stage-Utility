// A screen's role now comes from the view it shows; this takes the role an
// older build stored on the screen out of the data, without changing what any
// screen does.
//
// Until now a screen carried `mode: "display" | "panel"` and a view carried
// `surface: "display" | "console"`, and the server forced the two to agree. The
// screen's copy was redundant, and is gone. What is stored on an install is not
// always in agreement, though (a restored backup, a hand edit, an API call that
// took a view id as given), and the one pairing that must never change on the
// way through is a screen that was read-only becoming live: a console on a wall
// screen drew its buttons and did nothing, and must not start working because
// the field that said so was removed.
//
//   agree, or no view         the stored role is dropped. Nothing changes.
//   was "display", on a       the screen keeps showing what it showed, read-only,
//   console                   by pointing at a wall copy of the view.
//   was "panel", on a wall    its buttons were live, so they stay live: the view
//   view                      becomes a console when every screen showing it was
//                             a panel; otherwise those screens share a control-
//                             surface copy. A view that is not a custom view has
//                             no buttons to keep, so only the role is dropped.
//
// A screen with no stored role was a read-only display. That is what the old
// readers assumed, so on the FIRST pass (`absentIsDisplay`) it is treated the
// same: a console shown by a screen that never said so is copied, not woken up.
//
// Pure: no I/O, no logging. It decides; the controller makes the copies (a
// copy takes new ids and a slots board) and reports. Idempotent, because the
// output carries no stored role for a second pass to find.

import { copyViewName, viewCanBeControlSurface, viewSurface, type ViewSurface } from "../types/views.js";

/** A copy of a view the controller must make, and the screens that will show it. */
export interface PlannedViewCopy {
  sourceViewId: string;
  name: string;
  surface: ViewSurface;
  /** The screens pointed at the copy once it exists. */
  screenIds: string[];
}

export interface ScreenRolePlan {
  /** Every screen, its stored role removed. A screen that needs a copy still
   *  names its old view here; the controller repoints it. */
  outputs: Output[];
  /** Views to make consoles, by id. */
  consoleViewIds: string[];
  copies: PlannedViewCopy[];
  /** One line per screen whose behaviour was kept by doing something, naming it. */
  notes: string[];
  /** Screens looked at. */
  checked: number;
  /** Screens that needed more than the stored role dropped. */
  changed: number;
}

/** A screen as an older build stored it: with the role this module removes.
 *  Output no longer has the field, so nothing else can read it by accident. */
export type StoredOutput = Output & { mode?: unknown };

/** A screen's stored role as the old readers saw it: only an explicit "panel"
 *  was live, and anything else, including nothing, was read-only. */
const wasPanel = (o: StoredOutput): boolean => o.mode === "panel";

/** The same screen with no stored role. The screen itself when it had none, so a
 *  list with nothing to remove is not rebuilt (and not written). */
function withoutMode(o: StoredOutput): Output {
  if (!("mode" in o)) return o;
  const { mode: _gone, ...rest } = o;
  return rest;
}

/** Mark a screen as having been live, for the pass that reads it. The surface
 *  migration uses this when it turns a view with buttons into a console: the
 *  screens showing it were working control surfaces before there was a field. */
export function markedLive(o: Output): StoredOutput {
  return { ...o, mode: "panel" };
}

/** Does any screen still carry a stored role? */
export function carriesStoredRole(outputs: readonly StoredOutput[]): boolean {
  return outputs.some((o) => "mode" in o);
}

export function planScreenRoles(
  views: readonly View[],
  outputs: readonly StoredOutput[],
  opts: { absentIsDisplay: boolean },
): ScreenRolePlan {
  const consoleViewIds = new Set<string>();
  const copies = new Map<string, PlannedViewCopy>();
  const notes: string[] = [];
  let changed = 0;
  const label = (o: Output) => `"${o.name || o.id}"`;

  const copyFor = (view: View, surface: ViewSurface, screen: Output): void => {
    const key = `${view.id}|${surface}`;
    const existing = copies.get(key);
    if (existing) existing.screenIds.push(screen.id);
    else copies.set(key, { sourceViewId: view.id, name: copyViewName(view, surface), surface, screenIds: [screen.id] });
  };

  for (const o of outputs) {
    const carries = "mode" in o;
    if (!carries && !opts.absentIsDisplay) continue;
    const view = o.viewId ? views.find((v) => v.id === o.viewId) : undefined;
    if (!view) continue;

    const surface = viewSurface(view);
    const panel = wasPanel(o);

    if (!panel && surface === "console") {
      copyFor(view, "display", o);
      changed += 1;
      notes.push(
        `${label(o)} was read-only but showed the control surface "${view.name}", whose buttons would have gone live; ` +
          `it now shows a wall copy, "${copyViewName(view, "display")}", and stays read-only`,
      );
    } else if (panel && surface === "display") {
      if (!viewCanBeControlSurface(view)) continue; // no controls to keep; the role is all that goes
      // Live screens only: one that was read-only must not be woken by the view
      // turning into a console. "Live" is what the old readers saw, so a screen
      // with no stored role counts as read-only here too.
      const showing = outputs.filter((x) => x.viewId === view.id);
      if (showing.every(wasPanel)) {
        if (!consoleViewIds.has(view.id)) {
          consoleViewIds.add(view.id);
          changed += 1;
          notes.push(
            `"${view.name}" is now a control surface: ${showing.map(label).join(", ")} had live buttons on it as a wall view`,
          );
        } else changed += 1;
      } else {
        copyFor(view, "console", o);
        changed += 1;
        notes.push(
          `${label(o)} had live buttons on the wall view "${view.name}", which other read-only screens also show; ` +
            `it now shows a control-surface copy, "${copyViewName(view, "console")}"`,
        );
      }
    }
  }

  return {
    outputs: outputs.map(withoutMode),
    consoleViewIds: [...consoleViewIds],
    copies: [...copies.values()],
    notes,
    checked: outputs.length,
    changed,
  };
}
