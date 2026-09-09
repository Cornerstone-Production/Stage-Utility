// The window and the ordering behind the editor's plan switcher.
//
// Two things here can quietly go wrong and both point an operator at the wrong
// week: a window that excludes the plan they are looking at, and an order that
// is not the order the arrows walk. Driven with a FIXED clock and an explicit
// time zone, because a window computed off the host clock rolls its date at
// 19:00 in Chicago on a UTC box.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  keepPlan,
  planWindow,
  sortUpcoming,
  switcherTypes,
  toUpcoming,
  withinWindow,
  UPCOMING_LOOKBACK_DAYS,
} from "./upcoming-plans.js";

const DAY = 24 * 60 * 60 * 1000;
/** 18:00 Chicago on Tuesday 8 September 2026 — after a UTC box has rolled its
 *  date, which is the case that broke recorders once already. */
const NOW = Date.parse("2026-09-08T23:00:00Z");
const CHICAGO = "America/Chicago";

function plan(id: string, sortDate: string | null, title = id): PlanDTO {
  return { id, title, seriesTitle: null, sortDate, dates: sortDate };
}

describe("the window", () => {
  it("starts seven whole days back and ends after the last requested day", () => {
    const w = planWindow(NOW, 60, CHICAGO);
    // Midnight Chicago on 8 Sep is 05:00Z on the 8th, NOT the 9th — which is
    // what a host-clock window would have computed at 23:00Z.
    const today = Date.parse("2026-09-08T05:00:00Z");
    assert.equal(w.from, today - UPCOMING_LOOKBACK_DAYS * DAY);
    assert.equal(w.to, today + 61 * DAY);
  });

  it("keeps a plan from earlier the same day", () => {
    const w = planWindow(NOW, 60, CHICAGO);
    assert.equal(
      withinWindow("2026-09-08T14:00:00Z", w),
      true,
      "an operator fixing a board after the service must still find the plan they are fixing",
    );
  });

  it("drops a plan older than the lookback and one past the horizon", () => {
    const w = planWindow(NOW, 60, CHICAGO);
    assert.equal(withinWindow("2026-08-25T14:00:00Z", w), false);
    assert.equal(withinWindow("2026-12-25T14:00:00Z", w), false);
  });

  it("drops an undated or unparseable plan, which cannot be placed among the others", () => {
    const w = planWindow(NOW, 60, CHICAGO);
    assert.equal(withinWindow(null, w), false);
    assert.equal(withinWindow("sometime in the fall", w), false);
  });
});

describe("the machine's own plan", () => {
  it("is kept however old it is", () => {
    const w = planWindow(NOW, 60, CHICAGO);
    assert.equal(
      keepPlan(plan("p-old", "2025-01-05T14:00:00Z"), w, "p-old"),
      true,
      "a switcher whose list does not contain the board on screen moves somewhere unrelated on the first arrow press",
    );
  });

  it("is kept with no date at all", () => {
    const w = planWindow(NOW, 60, CHICAGO);
    assert.equal(keepPlan(plan("p-undated", null), w, "p-undated"), true);
  });

  it("does not rescue somebody else's old plan", () => {
    const w = planWindow(NOW, 60, CHICAGO);
    assert.equal(keepPlan(plan("p-old", "2025-01-05T14:00:00Z"), w, "p-current"), false);
  });
});

describe("the order the arrows walk", () => {
  function row(planId: string, sortDate: string | null, title = planId): UpcomingPlan {
    return {
      serviceTypeId: "st",
      serviceTypeName: "Sunday",
      planId,
      title,
      sortDate,
      dates: null,
      isCurrent: false,
    };
  }

  it("is oldest first, across service types", () => {
    const sorted = sortUpcoming([
      row("sun", "2026-09-13T14:00:00Z"),
      row("wed", "2026-09-09T23:00:00Z"),
      row("sat", "2026-09-12T22:00:00Z"),
    ]);
    assert.deepEqual(
      sorted.map((p) => p.planId),
      ["wed", "sat", "sun"],
      "the arrows walk the week, so Wednesday's youth plan comes before Sunday's",
    );
  });

  it("puts undated plans last rather than first", () => {
    const sorted = sortUpcoming([row("undated", null), row("dated", "2026-09-13T14:00:00Z")]);
    assert.deepEqual(sorted.map((p) => p.planId), ["dated", "undated"]);
  });

  it("does not mutate its input", () => {
    const input = [row("b", "2026-09-13T14:00:00Z"), row("a", "2026-09-09T14:00:00Z")];
    sortUpcoming(input);
    assert.deepEqual(input.map((p) => p.planId), ["b", "a"]);
  });
});

describe("flattening a service type's plans", () => {
  const TYPE: ServiceTypeDTO = { id: "st-1", name: "Cornerstone Youth" };

  it("carries the type onto every row and flags the current plan", () => {
    const w = planWindow(NOW, 60, CHICAGO);
    const rows = toUpcoming(
      TYPE,
      [plan("p1", "2026-09-09T23:00:00Z", "Youth"), plan("p2", "2026-09-16T23:00:00Z", "Youth")],
      w,
      "p1",
    );
    assert.deepEqual(
      rows.map((r) => [r.serviceTypeId, r.serviceTypeName, r.planId, r.isCurrent]),
      [
        ["st-1", "Cornerstone Youth", "p1", true],
        ["st-1", "Cornerstone Youth", "p2", false],
      ],
    );
  });
});

describe("which service types the switcher covers", () => {
  const TYPES: ServiceTypeDTO[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];

  it("an empty allowlist means all of them", () => {
    assert.deepEqual(switcherTypes(TYPES, []).map((t) => t.id), ["a", "b"]);
  });

  it("a non-empty one means exactly those", () => {
    assert.deepEqual(switcherTypes(TYPES, ["b"]).map((t) => t.id), ["b"]);
  });
});
