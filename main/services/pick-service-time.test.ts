// serviceTimeId is part of every recorder's key, so picking the wrong service
// time files one service's recording under another's. The bug: PCO leaves
// `ends_at` null unless a plan time was given a length, and a missing end was
// treated as "still upcoming" — a test that never went false. On a Sunday with
// two end-less times the ascending sort returned the 9am one all day, so the
// 11am service was appended into the 9am's record.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pickServiceTime } from "./pick-service-time.js";

const at = (hhmm: string): string => `2026-08-09T${hhmm}:00.000Z`;
const t = (id: string, startsAt: string, endsAt?: string) => ({ id, startsAt, endsAt: endsAt ?? null });

// Two services, neither given a length in PCO — the shape that broke.
const NINE = t("st-9", at("14:00")); // 09:00 America/Chicago
const ELEVEN = t("st-11", at("16:00")); // 11:00
const ENDLESS = [NINE, ELEVEN];

describe("with no end times (the reported bug)", () => {
  it("picks the 9am before the 11am has started", () => {
    assert.equal(pickServiceTime(ENDLESS, Date.parse(at("14:30")))?.id, "st-9");
  });

  it("switches to the 11am once it starts, instead of staying on the 9am", () => {
    // The regression: this returned st-9, so the 11am recorded into the 9am's key.
    assert.equal(pickServiceTime(ENDLESS, Date.parse(at("16:15")))?.id, "st-11");
  });

  it("stays on the 11am after it is over, since nothing later has begun", () => {
    // The taper and the history record still belong to the service that just ran.
    assert.equal(pickServiceTime(ENDLESS, Date.parse(at("18:00")))?.id, "st-11");
  });

  it("picks the first service before the day has started", () => {
    assert.equal(pickServiceTime(ENDLESS, Date.parse(at("12:00")))?.id, "st-9");
  });

  it("holds the earlier service right up until the later one begins", () => {
    // A service running long must not be handed off early.
    assert.equal(pickServiceTime(ENDLESS, Date.parse(at("15:59")))?.id, "st-9");
    assert.equal(pickServiceTime(ENDLESS, Date.parse(at("16:00")))?.id, "st-11");
  });
});

describe("with end times, which stay more precise", () => {
  const NINE_E = t("st-9", at("14:00"), at("15:15")); // 09:00–10:15
  const ELEVEN_E = t("st-11", at("16:00"), at("17:15")); // 11:00–12:15
  const timed = [NINE_E, ELEVEN_E];

  it("moves to the next service in the gap between the two", () => {
    // 10:20: the 9am has genuinely ended, so the countdown belongs to the 11am.
    assert.equal(pickServiceTime(timed, Date.parse(at("15:20")))?.id, "st-11");
  });

  it("keeps the running service while it is running", () => {
    assert.equal(pickServiceTime(timed, Date.parse(at("14:30")))?.id, "st-9");
  });

  it("falls back to the last one when every service has ended", () => {
    assert.equal(pickServiceTime(timed, Date.parse(at("19:00")))?.id, "st-11");
  });
});

describe("mixed and degenerate input", () => {
  it("uses a later service's start to retire an end-less earlier one", () => {
    const mixed = [t("st-9", at("14:00")), t("st-11", at("16:00"), at("17:15"))];
    assert.equal(pickServiceTime(mixed, Date.parse(at("16:30")))?.id, "st-11");
  });

  it("returns the only service there is, whatever the time", () => {
    const one = [t("st-1", at("14:00"))];
    assert.equal(pickServiceTime(one, Date.parse(at("12:00")))?.id, "st-1");
    assert.equal(pickServiceTime(one, Date.parse(at("20:00")))?.id, "st-1");
  });

  it("returns null for no services at all", () => {
    assert.equal(pickServiceTime([], Date.parse(at("14:00"))), null);
  });

  it("never lets an unparseable time rule out a real service", () => {
    // Fail open: a stray row must not be able to retire a service that is running.
    const junk = [t("st-junk", "not a date"), NINE];
    assert.ok(pickServiceTime(junk, Date.parse(at("14:30"))) !== null);
  });

  it("does not care what order PCO returned them in", () => {
    const reversed = [ELEVEN, NINE];
    assert.equal(pickServiceTime(reversed, Date.parse(at("16:15")))?.id, "st-11");
    assert.equal(pickServiceTime(reversed, Date.parse(at("14:30")))?.id, "st-9");
  });
});
