import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

import { CAPABILITIES } from "@main/types/object-capabilities";
import { IDIOM_TYPES } from "@main/types/readout-types.js";

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
const READOUT_SRC = readFileSync(new URL("./readout.tsx", import.meta.url), "utf8");

describe("the object type registry", () => {
  test("holds exactly 59 types", () => {
    // An EXACT count, never a floor. A floor with slack is how three config
    // stores went missing from every backup with the suite green. When this
    // fails, the answer is not to bump the number: it is to run the browser
    // sweep against the new type and then bump the number.
    //
    // The design doc said 38 while the registry held 41 — three types had been
    // added without anyone re-reading it.
    assert.equal(Object.keys(CAPABILITIES).length, 59);
  });
});

describe("readouts fit their box through one shared measurement", () => {
  // Each of these overflowed its box at a normal dashboard tile size (257x159)
  // in the browser sweep — the status objects by up to 48px, because a dot plus
  // "OBS: Recording 00:12:34" is simply wider than a narrow tile.
  //
  // This used to name the COMPONENTS that rendered them and grep each one's body
  // for `useFitScale`. Those components are gone: they were StatusDot,
  // RecordingFill and FitBox, and every readout now goes through Readout
  // instead. A source-text guard cannot survive that, and worse, could not tell
  // it apart from the components quietly losing their measurement.
  //
  // So the assertion is on the routing itself. IDIOM_TYPES is the set the
  // renderer branches on, so membership is a fact about the running code rather
  // than words in a file — and it is keyed by object TYPE, which is what the
  // browser sweep actually measured.
  const OVERFLOWED = [
    "obs-status", "reaper-status", "record-status", "integration-status",
    "wireless-summary", "wireless-channel", "baptism-timer",
  ] as const;

  for (const type of OVERFLOWED) {
    test(`${type} renders through the shared Readout`, () => {
      assert.ok(IDIOM_TYPES.has(type), `${type} left the idiom and is fitting its box alone again`);
    });
  }

  test("there is exactly one implementation of the measurement", () => {
    // Two copies is how a fix lands in one readout and misses four others. The
    // idiom's own shrink-to-width lives in readout.tsx; useFitScale remains for
    // the objects that are not readouts (plain text, slide text, service items).
    const defs = SRC.match(/function useFitScale\b/g) ?? [];
    assert.equal(defs.length, 1, "useFitScale must be defined once");
    const shrink = READOUT_SRC.match(/function useShrinkToWidth\b/g) ?? [];
    assert.equal(shrink.length, 1, "useShrinkToWidth must be defined once");
  });

  test("the idiom is applied by the renderer, not just declared", () => {
    // A set nothing reads is a list of intentions. The branch that consumes it
    // is what stops a migrated type being wrapped in the old caption path as
    // well, which would render its caption twice.
    assert.match(SRC, /IDIOM_TYPES\.has\(o\.config\.type\)/, "the renderer no longer consults the set");
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
