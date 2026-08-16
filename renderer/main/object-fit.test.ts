import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

import { CAPABILITIES } from "@main/types/object-capabilities";

// What this file can and cannot prove, stated plainly, because a guard that
// quietly proves nothing is worse than no guard:
//
// It CANNOT measure overflow. jsdom has no layout engine — clientWidth and
// scrollWidth are both 0 for every element — so an assertion like
// `scrollWidth <= clientWidth` passes on every bug ever written. The sweep that
// found the real defects ran in a real browser, against a generated view holding
// one of every object type; see the commit and docs/reference/layout-editor.md
// for how to re-run it.
//
// It CAN pin the two things that would let those defects come back silently:
// the set of object types, and the fact that the readouts which overflowed all
// go through the shared fit-to-box measurement rather than each rolling its own.

const SRC = readFileSync(new URL("./layout-renderer.tsx", import.meta.url), "utf8");

describe("the object type registry", () => {
  test("holds exactly 48 types", () => {
    // An EXACT count, never a floor. A floor with slack is how three config
    // stores went missing from every backup with the suite green. When this
    // fails, the answer is not to bump the number: it is to run the browser
    // sweep against the new type and then bump the number.
    //
    // The design doc said 38 while the registry held 41 — three types had been
    // added without anyone re-reading it.
    assert.equal(Object.keys(CAPABILITIES).length, 48);
  });
});

describe("readouts fit their box through one shared measurement", () => {
  // Each of these overflowed its box at a normal dashboard tile size (257x159)
  // in the browser sweep. They are listed by the component that renders them, so
  // the assertion is about the code that had the bug, not about prose.
  const MUST_FIT = [
    "FitText",       // current/next service item
    "StatusDot",     // obs, reaper, record, integration, wireless status
    "RecordingFill", // the full-bleed red recording state
    "BaptismTimer",  // value plus its sub-label
    "PeoplePanel",   // wrapping metric tiles
  ];

  for (const component of MUST_FIT) {
    test(`${component} measures itself with useFitScale`, () => {
      // Match the component's body, not the whole file: every one of these could
      // be found "somewhere in the file" while the call sits in a different
      // function entirely.
      const start = SRC.indexOf(`function ${component}(`);
      assert.notEqual(start, -1, `${component} not found — was it renamed?`);
      const next = SRC.slice(start + 1).search(/\nfunction \w+\(/);
      const body = next === -1 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
      assert.match(
        body,
        /useFitScale[<(]/,
        `${component} must fit its box through the shared hook, not its own maths`,
      );
    });
  }

  test("there is exactly one implementation of the measurement", () => {
    // Two copies is how a fix lands in one readout and misses four others.
    const defs = SRC.match(/function useFitScale\b/g) ?? [];
    assert.equal(defs.length, 1, "useFitScale must be defined once");
  });
});

describe("a stacked column that outgrows the window can be reached", () => {
  test("the container scrolls instead of clipping", () => {
    // Stacking floors each band at 24px, so enough objects produce a column
    // taller than the window. Clipped, the tail was simply gone: no scrollbar,
    // no indication, content the operator could not get to.
    assert.match(SRC, /overflows\s*\?\s*"overflow-y-auto/, "must scroll when the column overflows");
    assert.match(SRC, /contentBottom\s*>\s*dims\.h/, "overflow is decided by the placed content");
  });
});
