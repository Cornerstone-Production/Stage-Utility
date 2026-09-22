// summarizeBaptism() feeds the panel's "Baptized" stat and the baptism-timer
// layout object's "count" field. `people` fills during the testimony pass in
// grouped mode — every entry gets pushed with `baptizeMs: 0` before anyone is
// baptized — so `people.length` counted testimonies, not baptisms. Three
// testimonies done and nobody in the water yet used to read "3 baptized."
//
// This is pre-existing (grouped mode has always filled `people` this way), but
// grouped is now the default workflow, so it is every service from here.
//
// Not covered here: the two on-screen consumers (Stat "Baptized" on the
// operator panel, the "count"/"average" fields on the layout object) render
// through Readout, whose sizing jsdom cannot see — see
// baptism-timer-armed.test.tsx. What is checked is the number this function
// hands them.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { summarizeBaptism } from "./use-baptism-state.js";

const BASE_STATE: BaptismState = {
  mode: "grouped",
  phase: "baptism",
  personNumber: 3,
  baptismIndex: 0,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  armed: false,
  sessionStartedAt: "2026-09-20T12:00:00.000Z",
  finishedAt: null,
  people: [],
  pendingTestimonyMs: null,
  serviceTitle: null,
  serviceTypeId: null,
  planId: null,
};

describe("a grouped session mid-testimony, nobody baptized yet", () => {
  const state: BaptismState = {
    ...BASE_STATE,
    people: [
      { testimonyMs: 60_000, baptizeMs: 0 },
      { testimonyMs: 45_000, baptizeMs: 0 },
      { testimonyMs: 30_000, baptizeMs: 0 },
    ],
  };

  test("count reads 0, not the testimony total", () => {
    // THE guard. `people.length` here is 3; nobody has been in the water.
    assert.equal(summarizeBaptism(state).count, 0);
  });

  test("avg baptism time is 0, not NaN or divided by testimony count", () => {
    assert.equal(summarizeBaptism(state).avgBaptizeMs, 0);
  });

  test("avg per person is 0 — nobody has completed a full baptism yet", () => {
    assert.equal(summarizeBaptism(state).avgPersonMs, 0);
  });
});

describe("a per-person session finished during a testimony", () => {
  // finish() while in "testimony" phase pushes a person with baptizeMs: 0 —
  // the same shape as the grouped case above, in the other workflow.
  const state: BaptismState = {
    ...BASE_STATE,
    mode: "per-person",
    people: [
      { testimonyMs: 50_000, baptizeMs: 20_000 },
      { testimonyMs: 40_000, baptizeMs: 0 },
    ],
    finishedAt: "2026-09-20T12:10:00.000Z",
  };

  test("count only credits the person actually baptized", () => {
    assert.equal(summarizeBaptism(state).count, 1);
  });
});

describe("once someone is actually baptized", () => {
  const state: BaptismState = {
    ...BASE_STATE,
    people: [
      { testimonyMs: 60_000, baptizeMs: 30_000 },
      { testimonyMs: 45_000, baptizeMs: 0 },
      { testimonyMs: 30_000, baptizeMs: 0 },
    ],
  };

  test("count is 1, not 3", () => {
    assert.equal(summarizeBaptism(state).count, 1);
  });

  test("avg baptism time divides by the baptized count, not by everyone who testified", () => {
    // 30_000 / 1 baptized, not / 3 testified.
    assert.equal(summarizeBaptism(state).avgBaptizeMs, 30_000);
  });

  test("avg per person is that one person's own total, not diluted by testimony-only entries", () => {
    // 60_000 + 30_000 = 90_000, over the 1 person who actually finished — not
    // over 3, which would fold in two testimonies nobody has been baptized
    // for yet.
    assert.equal(summarizeBaptism(state).avgPersonMs, 90_000);
  });
});

describe("no session", () => {
  test("summarizes to zero, not a throw", () => {
    const sum = summarizeBaptism(null);
    assert.equal(sum.count, 0);
    assert.equal(sum.avgPersonMs, 0);
    assert.equal(sum.avgBaptizeMs, 0);
    assert.equal(sum.avgTestimonyMs, 0);
  });
});
