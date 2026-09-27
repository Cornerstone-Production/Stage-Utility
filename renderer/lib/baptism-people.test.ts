// baptism-people.test.ts — the reduction shared by baptismStats
// (link-baptisms.ts, over sessions) and summarizeBaptism
// (main/use-baptism-state.ts, over live state), and a cross-check that the
// two public surfaces built on it still agree — the two independently wrote
// the identical "never count people.length" reduction before this file
// existed, which is exactly how a divergence could go unnoticed.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { reduceBaptismPeople } from "./baptism-people.js";
import { baptismStats } from "./link-baptisms.js";
import { summarizeBaptism } from "../main/use-baptism-state.js";

const PEOPLE = [
  { testimonyMs: 108_000, baptizeMs: 42_000 },
  { testimonyMs: 96_000, baptizeMs: 0 }, // mid-testimony, never baptized
  { testimonyMs: 60_000, baptizeMs: 30_000 },
];

describe("reduceBaptismPeople", () => {
  test("baptized excludes a mid-testimony entry (baptizeMs: 0), testified does not", () => {
    const r = reduceBaptismPeople(PEOPLE);
    assert.equal(r.testified, 3, "everyone who testified");
    assert.equal(r.baptized, 2, "only the two with a real baptizeMs");
    assert.equal(r.totalTestimonyMs, 108_000 + 96_000 + 60_000, "testimony sums over EVERYONE who testified");
    assert.equal(r.totalBaptizeMs, 42_000 + 30_000, "baptism sums over BAPTIZED people only");
    assert.equal(r.totalBaptizedPersonMs, 108_000 + 42_000 + (60_000 + 30_000), "person totals, baptized people only");
  });

  test("no people reduces to all zeros, not a throw", () => {
    assert.deepEqual(reduceBaptismPeople([]), {
      testified: 0,
      baptized: 0,
      totalTestimonyMs: 0,
      totalBaptizeMs: 0,
      totalBaptizedPersonMs: 0,
    });
  });
});

describe("baptismStats and summarizeBaptism agree on the same people", () => {
  test("the same figures come back through both surfaces, unit for unit", () => {
    const session: BaptismSession = {
      id: "bap-1",
      startedAt: "2026-09-20T15:00:00.000Z",
      finishedAt: "2026-09-20T15:17:23.000Z",
      people: PEOPLE,
      title: "Sunday Gathering",
      serviceTypeId: null,
      planId: null,
      serviceKey: "weekend:plan-1:1100",
    };
    const state: BaptismState = {
      mode: "grouped",
      phase: "baptism",
      personNumber: 3,
      baptismIndex: 2,
      segmentStartedAt: null,
      segmentAccumMs: 0,
      armed: false,
      sessionStartedAt: session.startedAt,
      finishedAt: null,
      people: PEOPLE,
      pendingTestimonyMs: null,
      serviceTitle: null,
      serviceTypeId: null,
      planId: null,
    };

    const stats = baptismStats([session]);
    const summary = summarizeBaptism(state);

    assert.equal(stats.people, summary.count, "same baptized count");
    assert.equal(stats.testimonySec * 1000, summary.totalTestimonyMs, "same testimony total, seconds vs ms");
    assert.equal(stats.baptismSec * 1000, summary.totalBaptizeMs, "same baptism total, seconds vs ms");
    assert.equal(stats.totalSec * 1000, summary.totalMs, "same combined total, seconds vs ms");
    assert.equal(stats.avgTestimonySec * 1000, summary.avgTestimonyMs, "same average testimony, seconds vs ms");
    assert.equal(stats.avgBaptismSec * 1000, summary.avgBaptizeMs, "same average baptism, seconds vs ms");
  });
});
