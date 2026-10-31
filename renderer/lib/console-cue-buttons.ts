// console-cue-buttons.ts — put a Cue button for a new cue on a console.
//
// The New cue dialog's "On a console" step: for each console ticked, add a
// `cue-button` layout object bound to the cue, at the bottom of that console's
// layout and sized like its other buttons.
//
// THE WRITE IS THE VIEWS API, NOT A SIDE DOOR. Each console is read fresh and
// written with `PATCH /api/views/:id { layout, layoutRev }`, so a console being
// edited in the layout editor at that moment answers 409 rather than losing the
// edit, and the layout editor's own save is not undone by this one. A 409 is
// retried ONCE from a fresh read: appending one object to whatever the layout is
// now is safe to redo, and anything past one retry is somebody editing in a loop.
//
// PARTIAL FAILURE IS RETURNED, NOT SWALLOWED. The cue is already created when
// this runs, and it is not rolled back because a console refused: the caller gets
// one result per console and says which failed. See addCueButtonToConsoles.

import { errorMessage } from "@main/services/errors";
import { screensListViews } from "@main/services/home-view";
import { viewIsConsole, type LayoutDTO, type LayoutObject, type View } from "@main/types/views";

import { uid } from "../editor/layout-templates";
import { defaultConfig, defaultStyleFor } from "../main/layout-objects";
import { invoke } from "./api";

/** The widgets that are buttons an operator presses: what "sized like its other
 *  buttons" looks at. */
const BUTTON_TYPES: ReadonlySet<string> = new Set(["cue-button", "osc-button", "rosstalk-button"]);

/** A button this wide and tall when the layout has none to copy: the size the
 *  layout editor gives a new widget with no size of its own. */
export const DEFAULT_BUTTON_SIZE = { w: 0.3, h: 0.16 } as const;

/** Space between the lowest thing in the layout and the new button, as a fraction
 *  of the canvas height. */
export const BUTTON_GAP = 0.02;

/** The consoles a cue button can go on: a control surface with a layout of its
 *  own. A calendar console has no layout objects to add one to, and HOME is a
 *  console with a layout that is not a canvas at all — it places cards on a grid
 *  from `home` placements and ignores x/y/w/h, so a button added with a canvas
 *  position would land on the grid at no place anybody chose. */
export function consolesWithLayouts(views: readonly View[]): View[] {
  return screensListViews(views).filter((v) => viewIsConsole(v) && v.kind === "custom");
}

/**
 * The font size (a fraction of canvas height) at which `text` fits a button this
 * big, or the cue button's own default when it already does.
 *
 * The default, 0.12, is the size the widget starts at: a word or two in a box
 * 0.3 of the canvas wide. A cue is named whatever somebody typed, and "Projectors
 * on" at 0.12 in that box is clipped at both edges. The cue button draws a state dot, the label in capitals at about 0.66em
 * a letter, and a line beneath, so the box has to hold roughly 2.4em of height
 * and the label's whole width. Nothing here reads the DOM: it is an estimate, and
 * errs small, because a label that is a little small is still a label.
 */
export function fitFontSize(text: string, box: { w: number; h: number }, canvas: { width: number; height: number }): number {
  const letters = Math.max(1, text.trim().length);
  const byWidth = (0.9 * box.w * canvas.width) / (0.66 * letters * canvas.height);
  const byHeight = (0.9 * box.h) / 2.4;
  // The widget's own default is the ceiling: a short name is not made bigger than
  // a button added by hand would be.
  const ceiling = defaultStyleFor("cue-button", { hostDrawsFrame: false }).fontSize ?? 0.12;
  return Math.max(0.02, Math.min(ceiling, byWidth, byHeight));
}

const BACKDROP_SPAN = 0.9;
/** Covers nearly the whole canvas, in both directions. */
const isBackdrop = (o: LayoutObject): boolean => o.w >= BACKDROP_SPAN && o.h >= BACKDROP_SPAN;

export interface PlacedButton {
  layout: LayoutDTO;
  /** There was no room below the existing content, so the button was put against
   *  the bottom edge and overlaps what is there. */
  overEdge: boolean;
}

/**
 * The layout with a cue button bound to `cue` added.
 *
 * AT THE BOTTOM: just under the lowest top-level object, in the column of the
 * layout's last button when it has one and centred when it has none. Sized like
 * that last button, with its style, so the new one looks like the others; the
 * editor's default size and style when there is no button to copy.
 *
 * Only top-level objects are looked at, and not a backdrop. A nested object's box is a fraction of
 * its container's, which is not the canvas's, so reading its bottom as one would
 * place the button somewhere meaningless.
 *
 * Where nothing fits below, the button goes against the bottom edge and says it
 * overlaps (`overEdge`) — the canvas is a fixed shape, and growing it would move
 * every other object.
 */
export function withCueButton(
  layout: LayoutDTO,
  cue: string,
  label: string,
  /** What the button will say when `label` is blank, for sizing its text. */
  shownAs: string = cue,
): PlacedButton {
  const buttons = layout.objects.filter((o) => BUTTON_TYPES.has(o.config.type));
  const reference = buttons.at(-1);
  const w = reference?.w ?? DEFAULT_BUTTON_SIZE.w;
  const h = reference?.h ?? DEFAULT_BUTTON_SIZE.h;
  // A BACKDROP is not content: a panel or frame that fills the canvas has its
  // bottom at the canvas's, so counting it puts every button on the bottom edge,
  // over the last one, whatever else is there.
  const content = layout.objects.filter((o) => !isBackdrop(o));
  const bottom = content.reduce((low, o) => Math.max(low, o.y + o.h), 0);
  const below = content.length === 0 ? 1 - h - BUTTON_GAP : bottom + BUTTON_GAP;
  const overEdge = below + h > 1;
  const y = overEdge ? Math.max(0, 1 - h) : below;
  const z = layout.objects.reduce((top, o) => Math.max(top, o.z), 0) + 1;

  const added: LayoutObject = {
    id: uid(),
    x: reference?.x ?? (1 - w) / 2,
    y,
    w,
    h,
    z,
    config: { ...defaultConfig("cue-button"), type: "cue-button", cue, label, showDevice: true },
    style: reference?.style
      ? { ...reference.style }
      : {
          ...defaultStyleFor("cue-button", { hostDrawsFrame: false }),
          fontSize: fitFontSize(label || shownAs, { w, h }, layout.canvas),
        },
  };
  return { layout: { ...layout, objects: [...layout.objects, added] }, overEdge };
}

/** What happened to one console. */
export interface ConsoleResult {
  viewId: string;
  /** The console's name as it was when read, or the id when it was not found. */
  name: string;
  ok: boolean;
  /** Why it was not written. Absent when `ok`. */
  error?: string;
  /** Written, but over the bottom edge. See PlacedButton. */
  overEdge?: boolean;
}

/** The seam a test replaces; production reads `/api/state` and PATCHes the view. */
export const consoleButtonDeps = {
  readViews: async (): Promise<View[]> => (await invoke<{ views?: View[] }>("stage:getState")).views ?? [],
  writeLayout: async (id: string, layout: LayoutDTO, layoutRev: number | undefined): Promise<void> => {
    await invoke("views:setLayout", { id, layout, layoutRev });
  },
};

/** What a plan decides for one view: the layout to write and how many Buttons it changed, or why not. */
type LayoutPlan = { layout: LayoutDTO; count: number; overEdge?: boolean } | { refuse: string };

/**
 * Read one view fresh, let `plan` change its layout, and write it with the revision
 * it was read at. The one place the rules live: a 409 is retried ONCE from a fresh
 * read (anything past one is somebody editing in a loop), `?? 0` is the revision of
 * a console that has never saved a layout (omitting it would be an unconditional
 * overwrite), and every outcome is RETURNED, never thrown.
 *
 * A plan that changes nothing (`count` 0) writes nothing and is not a failure.
 */
async function writeConsoleLayout(
  viewId: string,
  plan: (view: View) => LayoutPlan,
): Promise<ConsoleResult & { count: number }> {
  for (let attempt = 0; ; attempt++) {
    const view = (await consoleButtonDeps.readViews()).find((v) => v.id === viewId);
    if (!view) return { viewId, name: viewId, ok: false, count: 0, error: "it no longer exists" };
    const decided = plan(view);
    if ("refuse" in decided) return { viewId, name: view.name, ok: false, count: 0, error: decided.refuse };
    if (decided.count === 0) return { viewId, name: view.name, ok: true, count: 0 };
    try {
      await consoleButtonDeps.writeLayout(viewId, decided.layout, view.layoutRev ?? 0);
      return { viewId, name: view.name, ok: true, count: decided.count, ...(decided.overEdge ? { overEdge: true } : {}) };
    } catch (err) {
      if ((err as { status?: number }).status === 409 && attempt === 0) continue;
      return { viewId, name: view.name, ok: false, count: 0, error: errorMessage(err) };
    }
  }
}

function addToOne(viewId: string, cue: string, label: string, shownAs: string): Promise<ConsoleResult> {
  return writeConsoleLayout(viewId, (view) => {
    if (!viewIsConsole(view) || view.kind !== "custom" || !view.layout) {
      return { refuse: "it is no longer a console with a layout" };
    }
    const placed = withCueButton(view.layout, cue, label, shownAs);
    return { layout: placed.layout, count: 1, overEdge: placed.overEdge };
  });
}

/**
 * Add a cue button to each of `viewIds`, one console at a time.
 *
 * Never throws and never stops at a failure: every console gets a result, so one
 * that refuses does not stop the next from being written, and the caller can say
 * exactly which failed. A caller that ignores the results is the one swallowing.
 */
export async function addCueButtonToConsoles(
  viewIds: readonly string[],
  cue: string,
  label: string,
  /** The cue's name as people read it, for a blank label. */
  shownAs: string = cue,
): Promise<ConsoleResult[]> {
  const results: ConsoleResult[] = [];
  for (const id of viewIds) {
    try {
      results.push(await addToOne(id, cue, label, shownAs));
    } catch (err) {
      results.push({ viewId: id, name: id, ok: false, error: errorMessage(err) });
    }
  }
  return results;
}

// ── Repointing the Buttons of a renamed command ──────────────────────────────
//
// Renaming a command in its dialog lists the Buttons that name it (GET
// /api/cues/usage) and, on Save, points each at the new name. Same write as above,
// for the same reasons: each view is read fresh and written with its `layoutRev`, a
// 409 is retried once from a fresh read, and a view that refuses is RETURNED — the
// command is already renamed, and the dialog names the view and why.
//
// Unlike adding a Button, this changes objects the layout already holds, at any
// depth, so a stale tab cannot be allowed to retarget the wrong one: an object is
// repointed only while it is still a cue Button that names the OLD name. A Button
// the operator has since pointed elsewhere is left alone and not counted.

/** One view's outcome. `count` is the Buttons that were repointed in it. */
export type RepointResult = ConsoleResult & { count: number };

const norm = (a: unknown): string => (typeof a === "string" ? a.trim().toLowerCase() : "");

/**
 * `layout` with every cue Button in `objectIds` that names any of `from` pointed at
 * `to`, and how many that was. Immutable: a layout that changes nothing comes back
 * as the very same object, and so does every object that is not on the way to a change.
 */
export function withCueRepointed(
  layout: LayoutDTO,
  objectIds: ReadonlySet<string>,
  from: readonly string[],
  to: string,
): { layout: LayoutDTO; count: number } {
  const names = new Set(from.map(norm));
  let count = 0;
  const walk = (objects: readonly LayoutObject[]): LayoutObject[] =>
    objects.map((o) => {
      const before = count;
      const children = o.children?.length ? walk(o.children) : o.children;
      const hit =
        objectIds.has(o.id) &&
        (o.config as { type?: string }).type === "cue-button" &&
        names.has(norm((o.config as { cue?: unknown }).cue));
      if (hit) count++;
      if (!hit && count === before) return o;
      return { ...o, ...(children ? { children } : {}), ...(hit ? { config: { ...o.config, cue: to } } : {}) };
    });
  const objects = walk(layout.objects);
  return count === 0 ? { layout, count } : { layout: { ...layout, objects }, count };
}

function repointOne(viewId: string, objectIds: ReadonlySet<string>, from: readonly string[], to: string): Promise<RepointResult> {
  return writeConsoleLayout(viewId, (view) =>
    view.layout ? withCueRepointed(view.layout, objectIds, from, to) : { refuse: "it has no layout" },
  );
}

/**
 * Point each Button in `uses` (a command's places, as the usage lists them) from
 * the command named `from` to the one named `to`, one view at a time.
 *
 * Never throws and never stops at a failure: every view gets a result. A caller
 * that ignores the results is the one swallowing.
 */
export async function repointCueButtons(
  uses: readonly { viewId: string; objectId: string }[],
  /** Every name the Buttons may hold: the command's own and its former names. */
  from: readonly string[],
  to: string,
): Promise<RepointResult[]> {
  const byView = new Map<string, Set<string>>();
  for (const u of uses) {
    const ids = byView.get(u.viewId);
    if (ids) ids.add(u.objectId);
    else byView.set(u.viewId, new Set([u.objectId]));
  }
  const results: RepointResult[] = [];
  for (const [viewId, ids] of byView) {
    try {
      results.push(await repointOne(viewId, ids, from, to));
    } catch (err) {
      results.push({ viewId, name: viewId, ok: false, count: 0, error: errorMessage(err) });
    }
  }
  return results;
}

/** The most screens a log line names, and the most refusals logged one by one. Past either, a count. */
const LOG_NAMES = 4;
const LOG_REFUSALS = 6;
/** A reason is cut here, so a line carrying one still fits the log route's 300 characters beside the screen's name. */
const LOG_REASON = 140;
const cut = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/**
 * What a rename's repoints leave on /log: a short line saying what was repointed
 * (a count and the screens, then how many refused), and one line for each screen
 * that refused, with the reason. The refusals are lines of their own because the
 * log route cuts a line at 300 characters, and a reason is exactly the part that
 * sits at the end of a long one. Empty when no view was involved.
 */
export function repointLogLines(from: string, to: string, results: readonly RepointResult[]): string[] {
  if (results.length === 0) return [];
  const done = results.filter((r) => r.ok && r.count > 0);
  const refused = results.filter((r) => !r.ok);
  const buttons = done.reduce((n, r) => n + r.count, 0);
  const names = done.slice(0, LOG_NAMES).map((r) => cut(r.name, 40));
  if (done.length > LOG_NAMES) names.push(`${done.length - LOG_NAMES} more`);
  const head =
    `renamed ${from} to ${to}; repointed ${buttons} button${buttons === 1 ? "" : "s"}` +
    (names.length > 0 ? ` on ${names.join(", ")}` : "") +
    (refused.length > 0 ? `; ${refused.length} refused` : "");
  const lines = [head];
  for (const r of refused.slice(0, LOG_REFUSALS)) lines.push(`could not point the buttons on ${cut(r.name, 60)} at ${to}: ${cut(r.error ?? "refused", LOG_REASON)}`);
  if (refused.length > LOG_REFUSALS) lines.push(`${refused.length - LOG_REFUSALS} more screens refused ${to}; see the dialog`);
  return lines;
}
