import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ageLabel, formatAge, type AgeOptions } from "./age-label.js";
import { agoText } from "../app/video-feeds/feed-list.js";

describe("formatAge", () => {
  const rows: [string, number, AgeOptions, string][] = [
    ["inside now.under reads the caller's word", 29, { now: { under: 30, text: "just now" }, ago: true }, "just now"],
    ["at now.under is a minute", 30, { now: { under: 30, text: "just now" } }, "1 min"],
    ["ago", 120, { ago: true }, "2 min ago"],
    ["a minute is the floor without seconds", 5, {}, "1 min"],
    ["seconds", 8.4, { seconds: true }, "8 s"],
    ["seconds up to 59", 59, { seconds: true }, "59 s"],
    ["a minute", 60, { seconds: true }, "1 min"],
    ["59 minutes", 59 * 60, {}, "59 min"],
    ["an hour is hours by default", 3600, {}, "1 h"],
    ["hoursFrom keeps minutes longer", 89 * 60, { hoursFrom: 90 }, "89 min"],
    ["hoursFrom 90 flips at 90", 90 * 60, { hoursFrom: 90 }, "2 h"],
    ["hours keep counting without days", 30 * 3600, {}, "30 h"],
    ["days", 48 * 3600, { days: true }, "2 d"],
    ["a negative age is zero", -5, { seconds: true }, "0 s"],
    ["long seconds", 1, { seconds: true, long: true }, "1 second"],
    ["long minutes", 15 * 60, { long: true }, "15 minutes"],
    ["long hour", 3600, { long: true }, "1 hour"],
    ["long days", 48 * 3600, { long: true, days: true }, "2 days"],
  ];
  for (const [name, sec, opts, want] of rows) {
    test(name, () => assert.equal(formatAge(sec, opts), want));
  }
});

describe("ageLabel", () => {
  test("now, minutes, then hours", () => {
    assert.equal(ageLabel(100_000, 100_000 - 44_000), "now");
    assert.equal(ageLabel(100_000, 100_000 - 45_000), "1 min");
    assert.equal(ageLabel(10_000_000, 10_000_000 - 89 * 60_000), "89 min");
    assert.equal(ageLabel(10_000_000, 10_000_000 - 90 * 60_000), "2 h");
    assert.equal(ageLabel(100, 5_000), "now", "stamped ahead of the clock is never negative");
  });
});

describe("a camera check's age", () => {
  test("seconds, then minutes, then hours: an hour is not '60 min ago'", () => {
    assert.equal(agoText(4_000), "4 s ago");
    assert.equal(agoText(120_000), "2 min ago");
    assert.equal(agoText(3_600_000), "1 h ago");
  });
});
