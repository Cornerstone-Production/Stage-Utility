import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { everyViewKind, viewSurface, screenIsControlSurface, viewCanBeControlSurface } from "./views.js";

// A View declares what it is FOR, and that is the whole of a screen's role: a
// screen is a control surface exactly when the view it shows is a console. The
// surface field is OPTIONAL in the schema and read through viewSurface, so an
// existing views.json parses untouched.
//
// The default is the safety property. A View written before this field existed
// was rendering on a wall screen, so absent must mean "display": read-only, no
// live controls. Nothing becomes interactive by inference.

describe("surface defaults", () => {
  test("a View with no surface field is a display", () => {
    assert.equal(
      viewSurface({ id: "v1", name: "x", kind: "custom", createdAt: "" } as View),
      "display",
    );
  });

  test("an explicit console is respected", () => {
    assert.equal(viewSurface({ surface: "console" } as View), "console");
  });

  test("an unrecognised value falls back to the safe default", () => {
    // A hand-edited views.json, or a downgrade from a build that knew a third
    // surface. Anything not understood must read as the read-only one.
    assert.equal(viewSurface({ surface: "hologram" } as unknown as View), "display");
  });
});

describe("a screen's role is its view's surface", () => {
  const views = [
    { id: "wall", surface: "display" },
    { id: "ctl", surface: "console" },
    { id: "old" },
    { id: "odd", surface: "hologram" },
  ] as unknown as View[];
  const shows = (viewId: string | null) => screenIsControlSurface({ viewId }, views);

  test("a screen showing a console is a control surface", () => {
    assert.equal(shows("ctl"), true);
  });

  test("a screen showing a wall view is read-only", () => {
    assert.equal(shows("wall"), false);
  });

  test("a screen showing nothing is read-only", () => {
    assert.equal(shows(null), false);
  });

  test("a screen whose view is gone is read-only", () => {
    assert.equal(shows("deleted"), false);
  });

  test("a view with no surface, or one not understood, is read-only", () => {
    assert.equal(shows("old"), false);
    assert.equal(shows("odd"), false);
  });

  test("the kinds that can be a control surface are exactly these", () => {
    // Sorted, one per line. The renderer test (stage-view-paths.test.tsx) holds the
    // other end: it renders every kind as a wall screen and as a console and fails
    // when this list and what is drawn disagree.
    const kinds = everyViewKind(["slots", "dashboard", "stage", "transcription", "custom", "script", "spl-rundown", "calendar"]);
    assert.deepEqual(
      kinds.filter((kind) => viewCanBeControlSurface({ kind })).sort(),
      [
        "calendar",
        "custom",
      ],
    );
  });

  test("a kind this build does not know has nothing to operate", () => {
    assert.equal(viewCanBeControlSurface({ kind: "hologram" as never }), false);
  });
});
