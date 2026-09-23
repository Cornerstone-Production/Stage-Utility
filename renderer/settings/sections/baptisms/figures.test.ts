import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baptismFigures } from "./figures.js";

const started = Date.UTC(2026, 8, 27, 11, 0, 0);
const base = {
  mode: "grouped", phase: "idle", armed: false,
  sessionStartedAt: new Date(started).toISOString(),
  finishedAt: new Date(started + 29 * 60_000).toISOString(),
  personNumber: 1, baptismIndex: 0, segmentStartedAt: null, segmentAccumMs: 0,
  pendingTestimonyMs: null, serviceTitle: null, serviceTypeId: null, planId: null,
};
const by = (f: { key: string; value: string }[], k: string) => f.find((x) => x.key === k)?.value;

describe("baptismFigures", () => {
  it("keeps wall clock and timed apart, and names the difference", () => {
    const f = baptismFigures(
      { ...base, people: [{ testimonyMs: 108_000, baptizeMs: 42_000 }] } as never,
      started + 29 * 60_000,
    );
    assert.equal(by(f, "timed"), "2:30");
    assert.equal(by(f, "wall"), "29:00");
    assert.equal(by(f, "gap"), "26:30");
  });

  it("counts people baptized, not people who testified", () => {
    // Grouped: three testimonies banked, nobody in the water yet.
    const f = baptismFigures(
      { ...base, phase: "testimony", finishedAt: null,
        people: [{ testimonyMs: 60_000, baptizeMs: 0 }, { testimonyMs: 70_000, baptizeMs: 0 },
                 { testimonyMs: 80_000, baptizeMs: 0 }] } as never,
      started + 5 * 60_000,
    );
    assert.equal(by(f, "count"), "0");
  });

  // Only idle and the count were covered here — Timed's own LIVE arithmetic
  // (the running segment, and per-person's banked pendingTestimonyMs) was
  // untested, and either could be dropped from the sum without this file
  // noticing.
  it("timed adds the pending testimony AND the running segment on top of banked totals", () => {
    const segStart = started + 10 * 60_000;
    const now = segStart + 45_000; // 45s into the currently running baptism
    const f = baptismFigures(
      {
        ...base,
        mode: "per-person",
        phase: "baptism",
        finishedAt: null,
        segmentStartedAt: new Date(segStart).toISOString(),
        segmentAccumMs: 0,
        pendingTestimonyMs: 90_000, // this person's testimony, closed, not yet paired
        people: [{ testimonyMs: 60_000, baptizeMs: 40_000 }], // one already-finished person
      } as never,
      now,
    );
    // banked totalMs 100_000 (60_000+40_000) + pending 90_000 + live 45_000 =
    // 235_000ms = 3:55. Dropping either the pending testimony or the running
    // segment from the sum would read something other than 3:55.
    assert.equal(by(f, "timed"), "3:55");
  });
});
