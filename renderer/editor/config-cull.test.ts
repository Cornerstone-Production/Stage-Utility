import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

// The config cull removes CONTROLS, not stored data.
//
// A deliberate difference from the style cull, and worth being explicit about:
// styles were culled AND stopped being rendered, because the maintainer chose
// to apply the new look everywhere. Labels are what a display SAYS, not how it
// looks, so the renderer keeps honouring whatever an operator stored. Removing
// a control declutters the panel; silently changing a caption on a wall screen
// is a different thing and was not asked for.

const INSPECTOR = readFileSync(new URL("./inspector.tsx", import.meta.url), "utf8");
const RENDERER = readFileSync(new URL("../main/layout-renderer.tsx", import.meta.url), "utf8");

describe("the panel no longer offers these", () => {
  const GONE = [
    ["showLabel", /onConfig\(\{ \.\.\.c, showLabels?: v \}\)/],
    ["fillWhenRecording", /onConfig\(\{ \.\.\.c, fillWhenRecording: v \}\)/],
    ["autoFit", /onConfig\(\{ \.\.\.c, autoFit: v \}\)/],
    ["scroll", /onConfig\(\{ \.\.\.c, scroll: v \}\)/],
    ["orientation", /onConfig\(\{ \.\.\.c, orientation: v/],
  ] as const;

  for (const [name, pat] of GONE) {
    test(`${name} has no control`, () => {
      assert.ok(!pat.test(INSPECTOR), `${name} is offered again - deliberate? then update this list`);
    });
  }

  test("no showLabel gate hides a Label field", () => {
    // The regression this catches: removing the switch while leaving the field
    // gated behind it means a label you cannot reach and cannot turn back on.
    assert.ok(!/c\.showLabel/.test(INSPECTOR), "the inspector must not read showLabel at all");
  });
});

describe("a label you type is a label that shows", () => {
  test("every Label field is reachable, not conditional on a removed switch", () => {
    // Each RowText labelled "Label" must sit at the top level of its branch.
    const gated = INSPECTOR.split("\n").filter(
      (l, i, all) => l.includes('<RowText label="Label"') && /&& \($/.test(all[i - 1] ?? ""),
    );
    assert.deepEqual(gated, [], "a Label field is still gated behind a condition");
  });
});

describe("stored choices are still honoured", () => {
  // The renderer keeps reading these, so no display changes caption or stops
  // filling red on upgrade. The option left the panel, not the file.
  for (const key of ["showLabel", "fillWhenRecording", "autoFit"]) {
    test(`${key} is still read when rendering`, () => {
      assert.match(
        RENDERER,
        new RegExp(`\\b${key}\\b`),
        `${key} stopped being honoured - that would change what a display says`,
      );
    });
  }
});
