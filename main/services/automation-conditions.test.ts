// Conditions are the cross-cutting qualifiers — "only during a service", "only on
// Sundays". Without them the trigger list would explode into combinations like
// occupancy.crossed-above-during-service-on-sunday.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { AUTOMATION_CONDITIONS, allConditionsHold } from "./automation-conditions.js";
import type { ConditionCtx } from "../types/automation.js";

// Sunday 2026-07-26 is a Sunday; 10:00 local.
const SUNDAY_10AM = Date.parse("2026-07-26T10:00:00Z");
const ctx = (over: Partial<ConditionCtx> = {}): ConditionCtx => ({
  pcoLive: { mode: "item", serviceTimeId: "st1" },
  serviceTypeId: "weekend",
  integrations: {},
  obsRecording: false,
  reaperRecording: false,
  ...over,
});

describe("service.is-live", () => {
  const c = AUTOMATION_CONDITIONS["service.is-live"];
  test("holds while an item is live", () => {
    assert.equal(c.holds(ctx(), {}, SUNDAY_10AM), true);
  });
  test("does not hold pre-service or when nothing is live", () => {
    assert.equal(c.holds(ctx({ pcoLive: { mode: "preservice", serviceTimeId: null } }), {}, SUNDAY_10AM), false);
    assert.equal(c.holds(ctx({ pcoLive: null }), {}, SUNDAY_10AM), false);
  });
});

describe("service.type-is", () => {
  const c = AUTOMATION_CONDITIONS["service.type-is"];
  test("holds when the active service type matches", () => {
    assert.equal(c.holds(ctx(), { serviceTypeId: "weekend" }, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx(), { serviceTypeId: "youth" }, SUNDAY_10AM), false);
  });
  test("does not hold when no service type is active", () => {
    assert.equal(c.holds(ctx({ serviceTypeId: null }), { serviceTypeId: "weekend" }, SUNDAY_10AM), false);
  });
});

describe("time.day-of-week", () => {
  const c = AUTOMATION_CONDITIONS["time.day-of-week"];
  test("holds on a selected day", () => {
    const sunday = new Date(SUNDAY_10AM).getDay(); // local day index
    assert.equal(c.holds(ctx(), { days: String(sunday) }, SUNDAY_10AM), true);
  });
  test("does not hold on an unselected day", () => {
    const notToday = (new Date(SUNDAY_10AM).getDay() + 1) % 7;
    assert.equal(c.holds(ctx(), { days: String(notToday) }, SUNDAY_10AM), false);
  });
  test("accepts a comma-separated list", () => {
    const today = new Date(SUNDAY_10AM).getDay();
    assert.equal(c.holds(ctx(), { days: `${(today + 3) % 7},${today}` }, SUNDAY_10AM), true);
  });
  test("an empty selection holds — an unconfigured condition must not block", () => {
    assert.equal(c.holds(ctx(), { days: "" }, SUNDAY_10AM), true);
  });
});

describe("time.between", () => {
  const c = AUTOMATION_CONDITIONS["time.between"];
  const at = (h: number, m = 0) => {
    const d = new Date(SUNDAY_10AM);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  test("holds inside the window", () => {
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(10)), true);
  });
  test("does not hold outside it", () => {
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(8)), false);
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(13)), false);
  });
  test("handles a window crossing midnight", () => {
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(23)), true);
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(1)), true);
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(12)), false);
  });
});

describe("allConditionsHold", () => {
  test("an empty list always holds", () => {
    assert.equal(allConditionsHold([], ctx(), SUNDAY_10AM), true);
  });
  test("every condition must hold", () => {
    const ok = { id: "service.is-live", params: {} };
    const no = { id: "service.type-is", params: { serviceTypeId: "youth" } };
    assert.equal(allConditionsHold([ok], ctx(), SUNDAY_10AM), true);
    assert.equal(allConditionsHold([ok, no], ctx(), SUNDAY_10AM), false);
  });
  test("an unknown condition id fails CLOSED", () => {
    // A rule referencing a condition this build does not have must not fire.
    assert.equal(allConditionsHold([{ id: "nope", params: {} }], ctx(), SUNDAY_10AM), false);
  });
});

// ── Integration connections ────────────────────────────────────────────────

const INTEGRATION_IDS = [
  "companion", "obs", "osc", "planning-center", "prodcom", "propresenter",
  "reaper", "ross-tsl", "rosstalk", "sensource", "smaart", "wireless",
] as const;

describe("integration connection conditions", () => {
  test("is-connected is registered for every integration", () => {
    for (const id of INTEGRATION_IDS) {
      assert.ok(AUTOMATION_CONDITIONS[`${id}.is-connected`], `${id}.is-connected must be registered`);
    }
  });

  test("holds only while that integration reports connected", () => {
    const c = AUTOMATION_CONDITIONS["obs.is-connected"];
    assert.equal(c.holds(ctx({ integrations: { obs: "connected" } }), {}, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx({ integrations: { obs: "connecting" } }), {}, SUNDAY_10AM), false);
    assert.equal(c.holds(ctx({ integrations: {} }), {}, SUNDAY_10AM), false);
  });

  test("one integration's state does not satisfy another's condition", () => {
    const c = AUTOMATION_CONDITIONS["obs.is-connected"];
    assert.equal(c.holds(ctx({ integrations: { reaper: "connected" } }), {}, SUNDAY_10AM), false);
  });
});

// ── Recording state ────────────────────────────────────────────────────────

describe("recorder conditions", () => {
  test("obs.is-recording holds only while OBS records", () => {
    const c = AUTOMATION_CONDITIONS["obs.is-recording"];
    assert.ok(c, "obs.is-recording must be registered");
    assert.equal(c.holds(ctx({ obsRecording: true }), {}, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx({ obsRecording: false }), {}, SUNDAY_10AM), false);
  });

  test("reaper.is-recording holds only while REAPER records", () => {
    const c = AUTOMATION_CONDITIONS["reaper.is-recording"];
    assert.ok(c, "reaper.is-recording must be registered");
    assert.equal(c.holds(ctx({ reaperRecording: true }), {}, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx({ reaperRecording: false }), {}, SUNDAY_10AM), false);
  });

  test("the two recorders are independent", () => {
    assert.equal(
      AUTOMATION_CONDITIONS["obs.is-recording"].holds(ctx({ reaperRecording: true }), {}, SUNDAY_10AM),
      false,
    );
  });
});
