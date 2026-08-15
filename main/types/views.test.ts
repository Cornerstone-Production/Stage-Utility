import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { viewSurface, outputMode } from "./views.js";

// A View declares what it is FOR; an Output declares how it renders. Both fields
// are OPTIONAL in the schema and read through these accessors, so an existing
// views.json parses untouched — a required field would mean every install fails
// to load until migrated, and the migration needs the app to boot in order to run.
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

  test("an Output with no mode field is a display", () => {
    assert.equal(outputMode({ id: "o1", name: "x", viewId: null } as Output), "display");
  });

  test("an explicit console/panel is respected", () => {
    assert.equal(viewSurface({ surface: "console" } as View), "console");
    assert.equal(outputMode({ mode: "panel" } as Output), "panel");
  });

  test("an unrecognised value falls back to the safe default", () => {
    // A hand-edited views.json, or a downgrade from a build that knew a third
    // surface. Anything not understood must read as the read-only one.
    assert.equal(viewSurface({ surface: "hologram" } as unknown as View), "display");
    assert.equal(outputMode({ mode: "hologram" } as unknown as Output), "display");
  });
});
