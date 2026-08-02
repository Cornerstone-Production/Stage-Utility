import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scheduleItems } from "./automation-item-schedule.js";

const START = "2026-08-09T14:00:00.000Z";

const item = (title: string, lengthSec: number, itemType = "item") => ({ title, itemType, lengthSec });

// Doors (10m) -> Pre-roll (5m) -> [SERVICE START] -> Welcome (5m) -> Sermon
const PLAN = [
  item("Doors Open", 600),
  item("Pre-roll", 300),
  item("SERVICE START", 0, "header"),
  item("Welcome", 300),
  item("Sermon", 1800),
];

describe("scheduleItems", () => {
  it("puts the service-start header exactly on the service time", () => {
    const s = scheduleItems(PLAN, START);
    assert.equal(s.find((x) => x.title === "SERVICE START")?.dueAt, START);
  });

  it("schedules pre-service items backwards from the anchor", () => {
    const s = scheduleItems(PLAN, START);
    // Pre-roll is 5m of run time before the anchor; Doors is 10m before that.
    assert.equal(s.find((x) => x.title === "Pre-roll")?.dueAt, "2026-08-09T13:55:00.000Z");
    assert.equal(s.find((x) => x.title === "Doors Open")?.dueAt, "2026-08-09T13:45:00.000Z");
  });

  it("schedules in-service items forwards from the anchor", () => {
    const s = scheduleItems(PLAN, START);
    assert.equal(s.find((x) => x.title === "Welcome")?.dueAt, START);
    assert.equal(s.find((x) => x.title === "Sermon")?.dueAt, "2026-08-09T14:05:00.000Z");
  });

  it("anchors at the top of the plan when there is no marker header", () => {
    // Matches the countdown's own no-marker fallback, so the two agree.
    const s = scheduleItems([item("Doors Open", 600), item("Welcome", 300)], START);
    assert.equal(s[0].dueAt, START);
    assert.equal(s[1].dueAt, "2026-08-09T14:10:00.000Z");
  });

  it("ignores a non-header item that happens to be titled like the marker", () => {
    // Only a header row anchors the plan; a song called "Service Start" must not.
    const s = scheduleItems([item("Service Start", 600), item("Welcome", 300)], START);
    assert.equal(s[0].dueAt, START);
  });

  it("treats a missing or unset length as zero rather than shifting everything", () => {
    const s = scheduleItems([item("A", 0), item("B", -5), item("C", 120)], START);
    assert.equal(s[0].dueAt, START);
    assert.equal(s[1].dueAt, START);
    assert.equal(s[2].dueAt, START);
  });

  it("returns nothing when there is no usable service time", () => {
    // No anchor means no schedule. Guessing one would fire every rule at the
    // wrong moment, which is worse than the rule never arming.
    assert.deepEqual(scheduleItems(PLAN, null), []);
    assert.deepEqual(scheduleItems(PLAN, "not a date"), []);
  });

  it("returns an entry per item, in plan order", () => {
    const s = scheduleItems(PLAN, START);
    assert.deepEqual(s.map((x) => x.title), PLAN.map((x) => x.title));
  });

  it("marks every derived time as not exact", () => {
    assert.ok(scheduleItems(PLAN, START).every((x) => x.exact === false));
  });
});

describe("scheduleItems with plan_times", () => {
  const doorsAt = "2026-08-09T13:30:00.000Z";

  it("prefers a plan_time named after the item over the derived time", () => {
    // The whole point: an exact clock that survives the plan running long.
    const s = scheduleItems(PLAN, START, [{ name: "Doors Open", startsAt: doorsAt }]);
    const doors = s.find((x) => x.title === "Doors Open");
    assert.equal(doors?.dueAt, doorsAt);
    assert.equal(doors?.exact, true);
  });

  it("leaves every other item derived", () => {
    const s = scheduleItems(PLAN, START, [{ name: "Doors Open", startsAt: doorsAt }]);
    assert.equal(s.find((x) => x.title === "Welcome")?.exact, false);
    assert.equal(s.find((x) => x.title === "Welcome")?.dueAt, START);
  });

  it("matches the name case- and whitespace-insensitively", () => {
    const s = scheduleItems(PLAN, START, [{ name: "  dOOrs oPEN ", startsAt: doorsAt }]);
    assert.equal(s.find((x) => x.title === "Doors Open")?.dueAt, doorsAt);
  });

  it("matches the whole name, never a substring", () => {
    // A plan_time called "Service" must not claim "SERVICE START".
    const s = scheduleItems(PLAN, START, [{ name: "Service", startsAt: doorsAt }]);
    assert.ok(s.every((x) => x.exact === false));
  });

  it("schedules an exactly-timed item even with no service time at all", () => {
    // An exact time needs no anchor, so the rule still arms on a plan whose
    // service time is missing - which is exactly when the derived clock dies.
    const s = scheduleItems(PLAN, null, [{ name: "Doors Open", startsAt: doorsAt }]);
    assert.deepEqual(s, [{ title: "Doors Open", dueAt: doorsAt, exact: true }]);
  });

  it("ignores a plan_time with an unusable time rather than scheduling at NaN", () => {
    const s = scheduleItems(PLAN, START, [{ name: "Doors Open", startsAt: "whenever" }]);
    assert.equal(s.find((x) => x.title === "Doors Open")?.exact, false);
  });

  it("ignores an unnamed plan_time", () => {
    // The service times themselves carry name: null.
    const s = scheduleItems(PLAN, START, [{ name: "", startsAt: doorsAt }]);
    assert.ok(s.every((x) => x.exact === false));
  });

  it("keeps the first of two plan_times sharing a name", () => {
    const s = scheduleItems(PLAN, START, [
      { name: "Doors Open", startsAt: doorsAt },
      { name: "Doors Open", startsAt: "2026-08-09T13:00:00.000Z" },
    ]);
    assert.equal(s.find((x) => x.title === "Doors Open")?.dueAt, doorsAt);
  });
});
