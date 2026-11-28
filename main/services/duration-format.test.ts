import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatHms, formatSignedHms, pad2, type HmsOptions } from "./duration-format.js";

// One table per formatter: the input, the option set a caller deliberately
// chose, and the exact string. The U+2212 minus is typed as an escape so a
// hyphen cannot stand in for it.
const M = "−";

describe("formatHms", () => {
  const rows: [string, number, HmsOptions, string][] = [
    ["zero", 0, {}, "0:00"],
    ["under a minute", 5, {}, "0:05"],
    ["a minute", 60, {}, "1:00"],
    ["just under an hour", 3599, {}, "59:59"],
    ["an hour", 3600, {}, "1:00:00"],
    ["75 minutes", 4500, {}, "1:15:00"],
    ["rounds", 59.5, {}, "1:00"],
    ["floors when a clock is running", 59.9, { round: "floor" }, "0:59"],
    ["a negative clamps to zero", -5, {}, "0:00"],
    ["a negative clamps when flooring", -0.4, { round: "floor" }, "0:00"],
    ["a negative with a minus", -65, { negative: "minus" }, `${M}1:05`],
    ["a negative with a minus past an hour", -4500, { negative: "minus" }, `${M}1:15:00`],
    ["a hair under zero keeps its minus", -0.4, { negative: "minus" }, `${M}0:00`],
    ["hours never: minutes keep counting", 4500, { hours: "never" }, "75:00"],
    ["hours never, short", 65, { hours: "never" }, "1:05"],
    ["hours always, padded", 4500, { hours: "always", padHours: true }, "01:15:00"],
    ["hours always, padded, zero", 0, { hours: "always", padHours: true }, "00:00:00"],
    ["hours always, padded, past 99", 100 * 3600, { hours: "always", padHours: true }, "100:00:00"],
    ["hours always, unpadded", 59, { hours: "always" }, "0:00:59"],
    ["days", 86400 + 7200, { days: true }, "1d 2h"],
    ["days, negative", -(2 * 86400 + 3 * 3600), { days: true, negative: "minus" }, `${M}2d 3h`],
    ["just under a day stays h:mm:ss", 86399, { days: true }, "23:59:59"],
    ["days off by default", 90000, {}, "25:00:00"],
    ["a named zero", 0, { zero: "" }, ""],
    ["a named zero is only for zero", 1, { zero: "" }, "0:01"],
  ];
  for (const [name, sec, opts, want] of rows) {
    test(name, () => assert.equal(formatHms(sec, opts), want));
  }
});

describe("formatSignedHms", () => {
  const rows: [string, number, Parameters<typeof formatSignedHms>[1], string][] = [
    ["over", 65, undefined, "+1:05"],
    ["under", -65, undefined, `${M}1:05`],
    ["zero", 0, undefined, "0:00"],
    ["zero that always carries a sign", 0.2, { zero: "±0:00" }, "±0:00"],
    ["rounds", 64.6, undefined, "+1:05"],
    ["an hour over", 4500, undefined, "+1:15:00"],
    ["an hour over, minutes never roll into hours", 4500, { hours: "never" }, "+75:00"],
    ["days", -(86400 + 3600), { days: true }, `${M}1d 1h`],
  ];
  for (const [name, sec, opts, want] of rows) {
    test(name, () => assert.equal(formatSignedHms(sec, opts), want));
  }
});

test("pad2", () => {
  assert.equal(pad2(0), "00");
  assert.equal(pad2(7), "07");
  assert.equal(pad2(12), "12");
  assert.equal(pad2(123), "123");
});
