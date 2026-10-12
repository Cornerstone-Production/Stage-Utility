// A screen's role now comes from the view it shows; this takes the role an
// older build stored on the screen out of the data, without changing what any
// screen does.
//
// An older build stored `mode: "display" | "panel"` on a screen and `surface:
// "display" | "console"` on a view, and the server forced the two to agree. The
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
// The exception is a screen the surface migration just made live, which arrives
// as `liveScreenIds`: it never had a stored role, and its buttons worked.
//
// Pure: no I/O, no logging. It decides; the controller makes the copies (a
// copy takes new ids and a slots board) and reports. A second pass over its own
// output finds nothing, because that output carries no stored role.

import { viewCanBeControlSurface, viewSurface, type ViewSurface } from "../types/views.js";

/** What the copy of a view made for one screen is called. */
function copyViewName(view: Pick<View, "name">, surface: ViewSurface): string {
  return `${view.name} (${surface === "console" ? "control surface" : "wall"})`;
}

/**
 * A view this migration makes a control surface, whether by turning it into one
 * or by copying it into one.
 *
 * Two things follow from the screens that were showing it. They were fixed-aspect
 * panels, and a console reflows to whatever window it is on unless its layout
 * says otherwise, so a layout with no explicit fit gets `contain`, the fit it
 * had as a wall view: the panel does not move on upgrade. And the operator never
 * asked for it to appear in the sidebar, so it does not.
 */
export function asMigratedConsole(view: View): View {
  const layout = view.layout && view.layout.canvas.fit === undefined
    ? { ...view.layout, canvas: { ...view.layout.canvas, fit: "contain" as const } }
    : view.layout;
  return { ...view, surface: "console", showInSidebar: false, ...(layout === undefined ? {} : { layout }) };
}

/** What a view draws, for comparing a copy to its source: object ids differ in a
 *  copy by design, so they are left out. */
function content(view: View): string {
  return JSON.stringify({ kind: view.kind, ndiSource: view.ndiSource ?? null, layout: view.layout ?? null }, (key, value) =>
    key === "id" ? undefined : value,
  );
}

/**
 * A copy an interrupted upgrade left behind, to reuse instead of copying again.
 *
 * The views are saved before the screens are repointed, so a process that died
 * between the two leaves the copy on disk with no screen showing it, and the
 * pass that runs again plans the same copy. A view qualifies when it carries the
 * planned name and surface, no screen shows it, and it draws what the copy would
 * draw (ids aside). Anything else with that name is the operator's.
 */
export function findLeftoverCopy(
  views: readonly View[],
  outputs: readonly Output[],
  source: View,
  planned: Pick<PlannedViewCopy, "name" | "surface">,
): View | undefined {
  const shown = new Set(outputs.map((o) => o.viewId));
  const wanted = content(planned.surface === "console" ? asMigratedConsole(source) : source);
  return views.find(
    (v) => v.id !== source.id && v.name === planned.name && viewSurface(v) === planned.surface && !shown.has(v.id) && content(v) === wanted,
  );
}

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
  /** Screens that carried a stored role, or were made live by the surface
   *  migration: 0 means this load had nothing of the kind to take out. */
  carried: number;
  /** Screens that needed more than the stored role dropped. */
  changed: number;
}

/** A screen as an older build stored it: with the role this module removes.
 *  Output no longer has the field, so nothing else can read it by accident. */
export type StoredOutput = Output & { mode?: unknown };


/** The same screen with no stored role. The screen itself when it had none, so a
 *  list with nothing to remove is not rebuilt (and not written). */
function withoutMode(o: StoredOutput): Output {
  if (!("mode" in o)) return o;
  const { mode: _gone, ...rest } = o;
  return rest;
}

export function planScreenRoles(
  views: readonly View[],
  outputs: readonly StoredOutput[],
  opts: {
    absentIsDisplay: boolean;
    /** Screens the surface migration made live in this same load: a view with
     *  buttons that had no surface yet became a console, so the screens showing
     *  it were working control surfaces. They carry no stored role to say so. */
    liveScreenIds?: ReadonlySet<string>;
  },
): ScreenRolePlan {
  const consoleViewIds = new Set<string>();
  const copies = new Map<string, PlannedViewCopy>();
  const notes: string[] = [];
  let changed = 0;
  let carried = 0;
  const liveIds = opts.liveScreenIds ?? new Set<string>();
  /** A screen's role as the old readers saw it: only an explicit "panel" (or a
   *  screen just made live) was live, and anything else, including nothing, was
   *  read-only. */
  const wasPanel = (o: StoredOutput): boolean => o.mode === "panel" || liveIds.has(o.id);
  const label = (o: Output) => `"${o.name || o.id}"`;

  const copyFor = (view: View, surface: ViewSurface, screen: Output): void => {
    const key = `${view.id}|${surface}`;
    const existing = copies.get(key);
    if (existing) existing.screenIds.push(screen.id);
    else copies.set(key, { sourceViewId: view.id, name: copyViewName(view, surface), surface, screenIds: [screen.id] });
  };

  for (const o of outputs) {
    const carries = "mode" in o || liveIds.has(o.id);
    if (carries) carried += 1;
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
      changed += 1;
      if (showing.every(wasPanel)) {
        if (!consoleViewIds.has(view.id)) {
          consoleViewIds.add(view.id);
          notes.push(
            `"${view.name}" is now a control surface: ${showing.map(label).join(", ")} had live buttons on it as a wall view`,
          );
        }
      } else {
        copyFor(view, "console", o);
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
    carried,
    changed,
  };
}
