import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  capabilityLive,
  layoutEditingLive,
  contextForOutput,
  type RenderContext,
} from "./render-context.js";
import type { Capability } from "@main/types/object-capabilities";

// The matrix from the design doc, asserted cell by cell rather than by spot
// check. Every cell is a decision someone made for a reason, and a table is only
// trustworthy if the whole thing is checked — the interesting failure is one
// cell flipping, not the shape being wrong.

const MATRIX: [RenderContext, Capability, boolean][] = [
  ["display", "readout", true],
  ["panel", "readout", true],
  ["shell", "readout", true],

  // The safety property: a wall screen renders a button and never fires it.
  ["display", "control", false],
  ["panel", "control", true],
  ["shell", "control", true],

  ["display", "editable", false],
  ["panel", "editable", true],
  ["shell", "editable", true],

  // Off on a panel too: a chrome-free screen has no navigation to drill into.
  ["display", "drilldown", false],
  ["panel", "drilldown", false],
  ["shell", "drilldown", true],
];

describe("capability gating", () => {
  for (const [ctx, cap, expected] of MATRIX) {
    test(`${cap} in a ${ctx} is ${expected ? "live" : "inert"}`, () => {
      assert.equal(capabilityLive(ctx, cap), expected);
    });
  }

  test("a wall display can do nothing but read out", () => {
    // Stated as a property rather than three cells, because this is THE claim
    // the whole phase makes.
    const live = (["readout", "control", "editable", "drilldown"] as Capability[])
      .filter((c) => capabilityLive("display", c));
    assert.deepEqual(live, ["readout"]);
  });
});

describe("layout editing", () => {
  test("is shell-only, so a pinned panel cannot be rearranged from the floor", () => {
    assert.equal(layoutEditingLive("shell"), true);
    assert.equal(layoutEditingLive("panel"), false);
    assert.equal(layoutEditingLive("display"), false);
  });
});

describe("contextForOutput", () => {
  test("an ordinary screen is a display", () => {
    assert.equal(contextForOutput(undefined, false), "display");
    assert.equal(contextForOutput("display", false), "display");
  });

  test("a screen set to panel is a panel", () => {
    assert.equal(contextForOutput("panel", false), "panel");
  });

  test("a PREVIEW is always a display, even of a panel", () => {
    // Otherwise the Screens page could advance the service by being looked at:
    // every card renders a live preview of what that screen shows.
    assert.equal(contextForOutput("panel", true), "display");
    assert.equal(contextForOutput("display", true), "display");
  });
});
