// clamp, and the reason it was not swept in mechanically.
//
// Thirty-odd sites wrote this out as a nested Math.max/Math.min. The obvious
// move is a regex, and the obvious move is wrong: `Math.min(a, b)` is
// symmetric, so nothing in the syntax says which argument is the VALUE and
// which is the BOUND. A first pass at this converted
//
//     Math.min(365, Math.max(1, Math.round(days)))     // clamp days to 1..365
//
// into `clamp(1, Math.round(days), 365)` — which reads as clamping the literal
// 1 — and that is not the same function of `days`. With days = 500 the original
// gives 365 and the rewrite gives 500, so a backup schedule set to 500 days
// would have been stored as 500 instead of the intended year. tsc cannot see
// it, and neither can any test that does not already know the bounds.
//
// Two of the rewrites were worse than wrong: this repo already had a clamp in
// shure-base.ts and another in layout-geometry.ts, and converting their bodies
// turned both into `clamp(...)` calling themselves. Infinite recursion, valid
// TypeScript, silent.
//
// So every site was read by hand, and the bounds that a machine would have
// inverted are pinned below.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clamp } from "./clamp.js";

describe("clamp", () => {
  it("passes a value already inside the range", () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it("holds at the bounds", () => {
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
    assert.equal(clamp(0, 0, 10), 0);
    assert.equal(clamp(10, 0, 10), 10);
  });

  it("matches the nested form it replaced, over the whole range", () => {
    // The equivalence being claimed, checked rather than asserted in prose.
    for (const v of [-100, -1, 0, 0.5, 1, 7, 99, 1000, NaN]) {
      const nested = Math.max(1, Math.min(365, v));
      const same = clamp(v, 1, 365);
      assert.equal(Number.isNaN(nested), Number.isNaN(same), `NaN handling differs at ${v}`);
      if (!Number.isNaN(nested)) assert.equal(same, nested, `differs at ${v}`);
    }
  });

  it("is NOT the same as clamping the low bound — the bug a regex introduces", () => {
    // The exact inversion the mechanical sweep produced, kept as the reason this
    // file exists. If these two were equal the whole caution would be pointless.
    const days = 500;
    assert.equal(clamp(days, 1, 365), 365, "the value is what gets clamped");
    assert.notEqual(clamp(1, days, 365), 365, "clamping the bound is a different function");
  });

  it("lets the low bound win when the range is inverted", () => {
    // Documented rather than guarded against: it is what the nested form did,
    // and a caller with lo > hi has a bug of its own to find.
    assert.equal(clamp(5, 10, 0), 10);
  });
});

describe("the bounds a mechanical sweep would have inverted", () => {
  // Each of these came from a site written `Math.min(HI, Math.max(LO, value))`,
  // where a regex reading the nesting order picks the wrong argument as the
  // value. Pinned with a value OUTSIDE the range, which is the only place the
  // two forms disagree.
  const CASES: [string, number, number, number, number][] = [
    // label,                         value,  lo,   hi,    expected
    ["backup interval days",           500,    1,   365,   365],
    ["backups kept",                   999,    1,   100,   100],
    ["reconnect hour of day",           99,    0,    23,    23],
    ["reconnect day of week",           99,    0,     6,     6],
    ["lead minutes",                  9999,    0,  1440,  1440],
    ["dormant minutes",               9999,    1,  1440,  1440],
    ["taper pre-service minutes",      999,    0,   240,   240],
    ["taper post-service minutes",     999,    0,   240,   240],
  ];

  for (const [label, v, lo, hi, expected] of CASES) {
    it(`${label}: ${v} outside ${lo}..${hi} clamps to ${expected}`, () => {
      assert.equal(clamp(v, lo, hi), expected);
      // And the inverted reading really would have been wrong here. Every case
      // is deliberately ABOVE its ceiling: below the floor the two readings can
      // coincide, so a value under `lo` proves nothing about the inversion.
      assert.notEqual(clamp(lo, v, hi), expected, "this case would not have caught the inversion");
    });
  }

  it("still enforces the floors, which the cases above do not exercise", () => {
    // The other direction, stated separately rather than folded into a table
    // that is about something else.
    assert.equal(clamp(0, 1, 1440), 1, "dormant minutes must be at least 1");
    assert.equal(clamp(0, 1, 365), 1, "a backup interval must be at least a day");
    assert.equal(clamp(-5, 0, 240), 0, "a taper window cannot be negative");
  });
});
