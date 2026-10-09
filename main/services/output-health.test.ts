import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  displaySignature, FRESH_TREND, judge, parseHealthReport, STREAK, type HealthTrend,
} from "./output-health.js";
import type { OutputHealthReport } from "../types/output-health.js";

const ok = (over: Partial<OutputHealthReport> = {}): OutputHealthReport => ({
  fps: 59.94, repeated: 0.2, dropped: 0, at: 1_700_000_000_000, ...over,
});

describe("a health report off the wire", () => {
  it("is taken as sent", () => {
    assert.deepEqual(parseHealthReport(ok()), { report: ok() });
  });

  it("is refused when any one field is not what it says", () => {
    const bad: [string, unknown][] = [
      ["not an object", "59.94"],
      ["an array", [59.94, 0, 0, 0]],
      ["null", null],
      ["fps missing", { ...ok(), fps: undefined }],
      ["fps a string", { ...ok(), fps: "59.94" }],
      ["fps negative", ok({ fps: -1 })],
      ["fps absurd", ok({ fps: 1e9 })],
      ["fps not finite", ok({ fps: Infinity })],
      ["repeated over 100", ok({ repeated: 100.5 })],
      ["repeated negative", ok({ repeated: -0.1 })],
      ["dropped fractional", ok({ dropped: 1.5 })],
      ["dropped negative", ok({ dropped: -1 })],
      ["dropped a string", { ...ok(), dropped: "0" }],
      ["at missing", { ...ok(), at: undefined }],
      ["at negative", ok({ at: -1 })],
    ];
    for (const [why, body] of bad) {
      assert.ok("error" in parseHealthReport(body), `${why} was accepted`);
    }
  });

  it("drops fields it does not know", () => {
    const parsed = parseHealthReport({ ...ok(), token: "x", extra: 1 });
    assert.deepEqual("report" in parsed && parsed.report, ok());
  });
});

/** Fold a run of reports through judge(), returning the trend after each. */
const run = (reports: OutputHealthReport[], from: HealthTrend = FRESH_TREND): HealthTrend[] => {
  const out: HealthTrend[] = [];
  let t = from;
  for (const r of reports) out.push((t = judge(t, r, "decklink")));
  return out;
};
const good = (dropped = 0) => ok({ dropped });
const late = (dropped = 0) => ok({ repeated: 12, dropped });

describe("whether an output is struggling", () => {
  it("is not, on a healthy output however long it runs", () => {
    assert.equal(run(Array.from({ length: 20 }, () => good())).at(-1)?.struggling, false);
  });

  it("is not on one bad report, nor on two", () => {
    const t = run([good(), late(), late()]);
    assert.equal(t.at(-1)?.struggling, false, "one slow stretch flagged an output");
  });

  it("is, after three late reports running", () => {
    const t = run([good(), ...Array.from({ length: STREAK }, () => late())]);
    assert.deepEqual(t.map((x) => x.struggling), [false, false, false, true]);
  });

  it("is, when the card drops frames report after report", () => {
    const t = run([good(0), good(2), good(5), good(9)]);
    assert.equal(t.at(-1)?.struggling, true, "a rising dropped count was not noticed");
  });

  it("is not, on a dropped count that merely stands still", () => {
    // Cumulative: frames dropped an hour ago are not frames being dropped now.
    const t = run([good(40), good(40), good(40), good(40), good(40)]);
    assert.equal(t.at(-1)?.struggling, false, "an old dropped count read as a live one");
  });

  it("a dropped count that falls is a reopened output, not a drop", () => {
    const t = run([good(40), good(0), good(0), good(0)]);
    assert.equal(t.at(-1)?.struggling, false);
  });

  it("a reopen in the middle of a bad run is not the third bad report", () => {
    // 0 is the baseline, 5 and 10 are drops, and 0 is the output reopening. A
    // comparison that read any CHANGE as a drop counts that fourth report as a
    // third bad one and flags a healthy output; only a rise is a drop.
    const t = run([good(0), good(5), good(10), good(0)]);
    assert.deepEqual(t.map((x) => x.struggling), [false, false, false, false], "a count falling was read as a drop");
  });

  it("a good report in the middle starts the count again", () => {
    const t = run([late(), late(), good(), late(), late()]);
    assert.equal(t.at(-1)?.struggling, false, "bad reports that were not in a row were counted together");
  });

  it("ends after three good reports running, and not before", () => {
    const struggling = run(Array.from({ length: STREAK }, () => late())).at(-1)!;
    assert.equal(struggling.struggling, true);
    const after = run([good(), good(), late(), good(), good()], struggling);
    assert.equal(after.at(-1)?.struggling, true, "recovery was declared on good reports that were not in a row");
    const recovered = run([good(), good(), good()], struggling);
    assert.deepEqual(recovered.map((x) => x.struggling), [true, true, false]);
  });
});

describe("a display output", () => {
  it("is never struggling, however its figures read", () => {
    let t = FRESH_TREND;
    for (const dropped of [0, 5, 10, 20, 40]) t = judge(t, { fps: 0, repeated: 50, dropped, at: 1 }, "display");
    assert.equal(t.struggling, false);
  });

  it("nor is a device that is not an output at all", () => {
    let t = FRESH_TREND;
    for (const dropped of [0, 5, 10, 20, 40]) t = judge(t, { fps: 0, repeated: 50, dropped, at: 1 }, undefined);
    assert.equal(t.struggling, false);
  });
});

describe("what a person reads of a report", () => {
  const h = (over: Partial<Parameters<typeof displaySignature>[0]> = {}) =>
    ({ fps: 59.94, repeated: 0.2, dropped: 0, struggling: false, ...over });

  it("does not change for a reading that rounds to the same figures", () => {
    assert.equal(displaySignature(h()), displaySignature(h({ fps: 59.93, repeated: 0.21 })));
  });

  it("changes for each figure that is shown", () => {
    const base = displaySignature(h());
    for (const over of [{ fps: 30 }, { repeated: 4 }, { dropped: 1 }, { struggling: true }]) {
      assert.notEqual(displaySignature(h(over)), base, JSON.stringify(over));
    }
  });
});
