import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { migrateSurfaces, migrationLog } from "./surface-migration.js";
import { viewSurface, outputMode } from "../types/views.js";

// The migration exists so that upgrading does not silently disable the buttons
// on a touch panel that works today. These build real layouts and run the real
// function, rather than asserting field values on a fixture — the design doc
// asks for exactly that, because "surface is console" is not the property that
// matters. "The button still works" is.

function view(over: Partial<View> & { id: string }): View {
  return {
    name: over.id,
    kind: "custom",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  } as View;
}

function layout(objects: unknown[]) {
  return {
    version: 1,
    canvas: { width: 1920, height: 1080, background: null },
    objects,
  } as unknown as LayoutDTO;
}

/** A real LayoutObject: the type lives on `config`, not the object. Building the
 *  wrong shape here is how a test comes to agree with a wrong implementation
 *  rather than with the schema - which is exactly what happened first. */
const obj = (type: string, extra: Record<string, unknown> = {}) =>
  ({ id: `${type}-1`, x: 0, y: 0, w: 10, h: 10, z: 0, config: { type }, ...extra }) as unknown as LayoutObject;

describe("surface migration", () => {
  test("a View with an OSC button becomes a console, and its screen a panel", () => {
    // The case that would otherwise break: a working touch panel.
    const views = [view({ id: "v1", name: "Booth Panel", layout: layout([obj("osc-button")]) })];
    const outputs = [{ id: "out1", name: "Booth Touchscreen", viewId: "v1" }] as Output[];

    const r = migrateSurfaces(views, outputs);

    assert.equal(viewSurface(r.views[0]), "console");
    assert.equal(outputMode(r.outputs[0]), "panel");
  });

  test("a View with no controls is left as a display", () => {
    const views = [view({ id: "v2", name: "Lobby Wall", layout: layout([obj("clock")]) })];
    const outputs = [{ id: "out2", name: "Lobby", viewId: "v2" }] as Output[];

    const r = migrateSurfaces(views, outputs);

    assert.equal(viewSurface(r.views[0]), "display");
    assert.equal(outputMode(r.outputs[0]), "display");
    assert.equal(r.changed.length, 0, "nothing to report when nothing moved");
  });

  test("a control nested inside a container is found", () => {
    // Containers nest. A top-level filter would migrate this View to display and
    // kill the button inside the group - the bug this walk exists to prevent.
    const views = [
      view({
        id: "v3",
        name: "Nested",
        layout: layout([obj("container", { children: [obj("osc-button")] })]),
      }),
    ];

    const r = migrateSurfaces(views, [] as Output[]);

    assert.equal(viewSurface(r.views[0]), "console");
  });

  test("a control nested two containers deep is still found", () => {
    const views = [
      view({
        id: "v4",
        name: "Deep",
        layout: layout([
          obj("container", { children: [obj("container", { children: [obj("live-controls")] })] }),
        ]),
      }),
    ];

    assert.equal(viewSurface(migrateSurfaces(views, [] as Output[]).views[0]), "console");
  });

  test("every screen showing a console View is moved, not just the first", () => {
    // One View drives many Outputs. Moving only one would leave the others
    // rendering a console they may not bind to.
    const views = [view({ id: "v1", name: "Panel", layout: layout([obj("rosstalk-button")]) })];
    const outputs = [
      { id: "a", name: "Stage Left", viewId: "v1" },
      { id: "b", name: "Stage Right", viewId: "v1" },
      { id: "c", name: "Lobby", viewId: "other" },
    ] as Output[];

    const r = migrateSurfaces(views, outputs);

    assert.equal(outputMode(r.outputs[0]), "panel");
    assert.equal(outputMode(r.outputs[1]), "panel");
    assert.equal(outputMode(r.outputs[2]), "display", "an unrelated screen must not move");
  });

  test("it reports what it moved, so a stray control can be demoted", () => {
    const views = [
      view({ id: "v1", name: "Lobby Wall", layout: layout([obj("live-controls")]) }),
    ];

    const r = migrateSurfaces(views, [] as Output[]);

    assert.equal(r.changed.length, 1);
    assert.equal(r.changed[0].viewName, "Lobby Wall");
    assert.deepEqual(r.changed[0].controls, ["live-controls"]);
    assert.match(migrationLog(r).join("\n"), /Lobby Wall/);
  });

  test("it is idempotent — a second pass changes nothing", () => {
    // It runs against whatever is on disk. Re-deciding on every boot would undo
    // a deliberate demotion the operator made.
    const views = [view({ id: "v1", name: "Panel", layout: layout([obj("osc-button")]) })];
    const outputs = [{ id: "out1", name: "Booth", viewId: "v1" }] as Output[];

    const first = migrateSurfaces(views, outputs);
    const second = migrateSurfaces(first.views, first.outputs);

    assert.equal(second.changed.length, 0);
    assert.equal(viewSurface(second.views[0]), "console");
    assert.equal(outputMode(second.outputs[0]), "panel");
  });

  test("a deliberate demotion survives the next run", () => {
    // The point of idempotence, stated as the operator's story: they saw the log,
    // decided that wall display should NOT be a panel, and set it back.
    const views = [
      view({ id: "v1", name: "Wall", surface: "display", layout: layout([obj("live-controls")]) }),
    ];
    const outputs = [{ id: "out1", name: "Lobby", viewId: "v1", mode: "display" }] as Output[];

    const r = migrateSurfaces(views, outputs);

    assert.equal(viewSurface(r.views[0]), "display", "the operator's decision must stand");
    assert.equal(outputMode(r.outputs[0]), "display");
    assert.equal(r.changed.length, 0);
  });

  test("a View with no layout at all is a display", () => {
    // The built-in kinds (slots, dashboard, ...) carry no layout.
    const views = [view({ id: "v1", name: "Mic Board", kind: "slots", layout: null })];
    assert.equal(viewSurface(migrateSurfaces(views, [] as Output[]).views[0]), "display");
  });
});
