// Give every existing View a surface, without changing what any screen does.
//
// Three interactive object types already exist — osc-button, rosstalk-button and
// live-controls — and they render on real screens today. Defaulting every View to
// "display" would silently disable the buttons on any touch panel currently in
// service: the screen would keep rendering, the buttons would keep drawing, and
// pressing one would do nothing. That is the worst possible failure, because
// nothing announces it.
//
// So the migration reads what is actually there. A View containing a control
// becomes a console, and the Outputs bound to it become panels. Behaviour is
// preserved with no operator action, and what moved is reported so a stray
// control that pulled a wall display into panel mode can be demoted
// deliberately.

import { isControl } from "../types/object-capabilities.js";
import { viewSurface, outputMode } from "../types/views.js";

export interface MigrationNote {
  viewId: string;
  viewName: string;
  /** The control object types that made this a console, for the log. */
  controls: string[];
  /** Names of the Outputs pulled to panel mode alongside it. */
  outputs: string[];
}

export interface MigrationResult {
  views: View[];
  outputs: Output[];
  changed: MigrationNote[];
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
 * Assign surfaces and modes, preserving current behaviour.
 *
 * Pure: no I/O, no persistence, no logging. The caller decides what to do with
 * the result, which is what makes this testable against a real layout.
 *
 * Idempotent — it runs against whatever is on disk, and a View that already
 * declares a surface is left exactly as it is. A second pass reports nothing.
 */
export function migrateSurfaces(
  views: readonly View[],
  outputs: readonly Output[],
): MigrationResult {
  const changed: MigrationNote[] = [];
  const toPanel = new Set<string>();

  const nextViews = views.map((v) => {
    // Already decided, by a previous run or by the operator. Never re-decide:
    // that would undo a deliberate demotion on every boot.
    if (v.surface !== undefined) return v;

    const controls = controlsIn(v.layout?.objects);
    if (controls.length === 0) return { ...v, surface: "display" as const };

    const bound = outputs.filter((o) => o.viewId === v.id);
    for (const o of bound) toPanel.add(o.id);
    changed.push({
      viewId: v.id,
      viewName: v.name,
      controls,
      outputs: bound.map((o) => o.name || o.id),
    });
    return { ...v, surface: "console" as const };
  });

  const nextOutputs = outputs.map((o) =>
    // Only ever promotes. An Output the operator already set is left alone.
    toPanel.has(o.id) && o.mode === undefined ? { ...o, mode: "panel" as const } : o,
  );

  return { views: nextViews, outputs: nextOutputs, changed };
}

/** Human-readable lines for the server log. Kept beside the migration so the
 *  wording and the decision cannot drift apart. */
export function migrationLog(result: MigrationResult): string[] {
  const lines = result.changed.map(
    (n) =>
      `${n.viewName} — has ${n.controls.join(", ")} -> console` +
      (n.outputs.length ? ` (screens moved to panel: ${n.outputs.join(", ")})` : " (not on any screen)"),
  );
  const displays = result.views.filter((v) => viewSurface(v) === "display").length;
  const panels = result.outputs.filter((o) => outputMode(o) === "panel").length;
  lines.push(
    `${result.changed.length} view${result.changed.length === 1 ? "" : "s"} moved to console, ` +
      `${displays} left as displays, ${panels} screen${panels === 1 ? "" : "s"} now panels`,
  );
  return lines;
}
