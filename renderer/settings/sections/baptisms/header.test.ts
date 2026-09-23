// header.test.ts — baptismReportText's plain-text summary, the Copy report
// button's clipboard target. Pure function, no DOM: the header COMPONENT
// (sticky positioning, the ResizeObserver measurement, the action group's
// wrap) is not unit-tested here, for the reason header.tsx's own top comment
// gives — see that file for what IS covered elsewhere (figures.test.ts) and
// what is only checked in a real browser.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { baptismReportText } from "./header.js";

const BASE: BaptismState = {
  mode: "grouped",
  phase: "idle",
  personNumber: 3,
  baptismIndex: 1,
  armed: false,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  sessionStartedAt: "2026-09-27T16:20:00.000Z",
  finishedAt: "2026-09-27T16:40:00.000Z",
  people: [],
  pendingTestimonyMs: null,
  serviceTitle: "Sunday Service",
  serviceTypeId: null,
  planId: null,
};

// This printed "baptism 0:00" for a mid-testimony person here, while the
// People table printed a dash for the identical entry — one rule now,
// shared between the two (see fmtBaptizeMs in use-baptism-state.ts).
describe("baptismReportText", () => {
  test("a mid-testimony person (baptizeMs 0) prints a dash, never baptism 0:00", () => {
    const text = baptismReportText(
      { ...BASE, people: [{ testimonyMs: 60_000, baptizeMs: 0 }] },
      [],
    );
    assert.ok(text.includes("baptism —"), `expected a dash for baptism; got: ${text}`);
    assert.equal(text.includes("baptism 0:00"), false, "must not claim a baptism took no time");
  });

  test("an actually baptized person still prints their real duration", () => {
    const text = baptismReportText(
      { ...BASE, people: [{ testimonyMs: 80_000, baptizeMs: 45_000 }] },
      [],
    );
    assert.ok(text.includes("baptism 0:45"), `expected the real duration; got: ${text}`);
  });
});
