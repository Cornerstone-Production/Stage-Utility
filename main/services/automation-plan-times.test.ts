import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planTimeDueIn } from "./automation-plan-times.js";

const T = (startsAt: string, timeType = "service") => ({ id: startsAt, name: null, timeType, startsAt });
const at = (iso: string) => Date.parse(iso);

describe("planTimeDueIn", () => {
  const times = [T("2026-08-09T14:30:00Z"), T("2026-08-08T23:00:00Z", "rehearsal")];

  it("fires in the window containing lead-time-before the plan time", () => {
    // 60 min before 14:30 is 13:30.
    const hit = planTimeDueIn(times, at("2026-08-09T13:29:55Z"), at("2026-08-09T13:30:05Z"), 60, ["service"]);
    assert.equal(hit?.startsAt, "2026-08-09T14:30:00Z");
  });

  it("does not fire in the window before, or the window after", () => {
    assert.equal(planTimeDueIn(times, at("2026-08-09T13:29:00Z"), at("2026-08-09T13:29:50Z"), 60, ["service"]), null);
    assert.equal(planTimeDueIn(times, at("2026-08-09T13:30:10Z"), at("2026-08-09T13:31:00Z"), 60, ["service"]), null);
  });

  it("is half-open so two adjacent windows cannot both fire", () => {
    // This is what makes the trigger exactly-once without storing anything.
    const boundary = at("2026-08-09T13:30:00Z");
    const a = planTimeDueIn(times, boundary - 1000, boundary, 60, ["service"]);
    const b = planTimeDueIn(times, boundary, boundary + 1000, 60, ["service"]);
    assert.ok((a === null) !== (b === null), "exactly one of the adjacent windows fires");
  });

  it("honours the time-type filter", () => {
    const from = at("2026-08-08T21:59:55Z");
    const to = at("2026-08-08T22:00:05Z");
    assert.equal(planTimeDueIn(times, from, to, 60, ["service"]), null);
    assert.ok(planTimeDueIn(times, from, to, 60, ["rehearsal"]));
  });

  it("fires for each time on the plan, not just the first", () => {
    // Rehearsal is often days before the service; firing only once would leave a
    // later roster change unapplied.
    const both = ["rehearsal", "service"];
    assert.ok(planTimeDueIn(times, at("2026-08-08T21:59:55Z"), at("2026-08-08T22:00:05Z"), 60, both));
    assert.ok(planTimeDueIn(times, at("2026-08-09T13:29:55Z"), at("2026-08-09T13:30:05Z"), 60, both));
  });

  it("treats an empty type list as 'any'", () => {
    assert.ok(planTimeDueIn(times, at("2026-08-09T13:29:55Z"), at("2026-08-09T13:30:05Z"), 60, []));
  });

  it("ignores unparseable or absent times rather than throwing", () => {
    assert.equal(planTimeDueIn([T("nonsense")], 0, 1, 60, ["service"]), null);
    assert.equal(planTimeDueIn([], 0, 1, 60, ["service"]), null);
  });

  it("refuses a window that did not advance, or a bad lead time", () => {
    const w = [at("2026-08-09T13:29:55Z"), at("2026-08-09T13:30:05Z")] as const;
    assert.equal(planTimeDueIn(times, w[1], w[0], 60, ["service"]), null, "backwards window");
    assert.equal(planTimeDueIn(times, w[0], w[0], 60, ["service"]), null, "zero-width window");
    assert.equal(planTimeDueIn(times, w[0], w[1], Number.NaN, ["service"]), null, "unset lead time");
  });
});
