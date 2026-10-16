// Give every existing View a surface, without changing what any screen does.
//
// Three interactive object types already exist — osc-button, rosstalk-button and
// live-controls — and they render on real screens today. Defaulting every View to
// "display" would silently disable the buttons on any control surface currently in
// service: the screen would keep rendering, the buttons would keep drawing, and
// pressing one would do nothing. That is the worst possible failure, because
// nothing announces it.
//
// So the migration reads what is actually there. A View containing a control
// becomes a console, and the screens bound to it are returned as live
// (`liveScreenIds`; screen-role-migration.ts keeps them live). Behaviour is
// preserved with no operator action, and what moved is reported so a stray
// control that pulled a wall display into a control surface can be demoted
// deliberately.

import { isControl } from "../types/object-capabilities.js";
import { screenIsControlSurface, screensShowing, viewSurface } from "../types/views.js";
import { plural } from "./plural.js";
import type { StoredOutput } from "./screen-role-migration.js";

export interface MigrationNote {
  viewId: string;
  viewName: string;
  /** The control object types that made this a console, for the log. */
  controls: string[];
  /** Names of the Outputs now showing it as a control surface. */
  outputs: string[];
}

export interface MigrationResult {
  views: View[];
  /** The screens, as they were given. */
  outputs: StoredOutput[];
  changed: MigrationNote[];
  /** Screens whose view just became a console and which had no stored role of
   *  their own: they were working control surfaces. A screen that already said
   *  it was read-only is not in here. */
  liveScreenIds: Set<string>;
}

/**
 * Every control object type in a layout, including inside containers.
 *
 * Containers nest, and a scan of top-level objects only would miss a button in a
 * group — migrating that View to display and killing the button inside it. That
 * is the whole reason this walks rather than filters.
 */
function controlsIn(objects: readonly LayoutObject[] | undefined): string[] {
  const found = new Set<string>();
  const walk = (list: readonly LayoutObject[] | undefined) => {
    for (const o of list ?? []) {
      // The object's type lives on its `config`, not the object itself.
      const type = o.config?.type;
      if (type && isControl(type)) found.add(type);
      // Containers hold children; reading the property rather than checking for
      // type === "container" means anything that grows children later is covered.
      walk(o.children);
    }
  };
  walk(objects);
  return [...found].sort();
}

/**
 * Assign surfaces, preserving current behaviour.
 *
 * Pure: no I/O, no persistence, no logging. The caller decides what to do with
 * the result, which is what makes this testable against a real layout.
 *
 * Idempotent — it runs against whatever is on disk, and a View that already
 * declares a surface is left exactly as it is. A second pass reports nothing.
 */
export function migrateSurfaces(
  views: readonly View[],
  outputs: readonly StoredOutput[],
): MigrationResult {
  const changed: MigrationNote[] = [];
  const liveScreenIds = new Set<string>();

  const nextViews = views.map((v) => {
    // Already decided, by a previous run or by the operator. Never re-decide:
    // that would undo a deliberate demotion on every boot.
    if (v.surface !== undefined) return v;

    const controls = controlsIn(v.layout?.objects);
    if (controls.length === 0) return { ...v, surface: "display" as const };

    const bound = screensShowing(v.id, outputs);
    for (const o of bound) if (o.mode === undefined) liveScreenIds.add(o.id);
    changed.push({
      viewId: v.id,
      viewName: v.name,
      controls,
      outputs: bound.map((o) => o.name || o.id),
    });
    return { ...v, surface: "console" as const };
  });

  // Only ever promotes: a screen that already carried a role is left as it said.
  return { views: nextViews, outputs: [...outputs], changed, liveScreenIds };
}

/** Human-readable lines for the server log. Kept beside the migration so the
 *  wording and the decision cannot drift apart. */
export function migrationLog(result: MigrationResult): string[] {
  const lines = result.changed.map(
    (n) =>
      `${n.viewName} — has ${n.controls.join(", ")} -> console` +
      (n.outputs.length ? ` (screens now control surfaces: ${n.outputs.join(", ")})` : " (not on any screen)"),
  );
  const displays = result.views.filter((v) => viewSurface(v) === "display").length;
  const controlSurfaces = result.outputs.filter((o) => screenIsControlSurface(o, result.views)).length;
  lines.push(
    `${plural(result.changed.length, "view")} moved to console, ` +
      `${displays} left as displays, ${plural(controlSurfaces, "screen now control surface", "screens now control surfaces")}`,
  );
  return lines;
}
