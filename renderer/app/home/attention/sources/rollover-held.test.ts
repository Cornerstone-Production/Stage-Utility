import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attentionInput } from "../test-input.js";
import { rolloverHeld } from "./rollover-held.js";

const NOW = 1_000_000_000_000;
const held = (over: Record<string, unknown> = {}) => ({
  planId: "p1",
  planTitle: "Sunday Gathering",
  planDates: "November 16, 2026",
  endsAt: new Date(NOW - 95 * 60_000).toISOString(),
  ...over,
});
const run = (rollover: unknown, planId = "p1") =>
  rolloverHeld.items(
    attentionInput({ now: NOW, mood: "live", state: { planId, planTitle: "Sunday Gathering", rolloverHeld: rollover } as unknown as StageState }),
  );

describe("rollover-held source", () => {
  it("fires while the server holds the followed plan, with how long past its planned end, and the way to pick a plan", () => {
    const [item, ...rest] = run(held());
    assert.deepEqual(rest, []);
    assert.equal(item.key, "rollover-held:p1", "keyed by the plan, so a snooze does not carry to next week's");
    assert.equal(item.severity, "warn");
    assert.equal(item.title, "Still following Sunday Gathering (November 16, 2026)");
    assert.equal(item.detail, "Planning Center says it is live, 1 h 35 min past its planned end · auto mode moves on when it ends");
    assert.deepEqual(item.fix, { label: "Pick a plan", route: "/plan", flash: "plan-selection" });
  });

  it("counts minutes under an hour, and whole hours without minutes", () => {
    assert.match(run(held({ endsAt: new Date(NOW - 25 * 60_000).toISOString() }))[0].detail, /, 25 min past its planned end/);
    assert.match(run(held({ endsAt: new Date(NOW - 3 * 60 * 60_000).toISOString() }))[0].detail, /, 3 h past its planned end/);
  });

  it("names the plan without a date when it has none", () => {
    assert.equal(run(held({ planDates: null }))[0].title, "Still following Sunday Gathering");
  });

  it("does not fire while nothing is held", () => {
    assert.deepEqual(run(null), []);
  });

  it("does not fire for a hold left from a plan the screens no longer follow", () => {
    assert.deepEqual(run(held(), "p2"), []);
  });

  it("contributes nothing from a server that does not report it", () => {
    assert.deepEqual(run(undefined), []);
  });
});
