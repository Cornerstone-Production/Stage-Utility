import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  DEFAULT_HOUR_CYCLE,
  clockOptions,
  displayHourCycle,
  formatClock,
  setDisplayHourCycle,
} from "./clock-format.js";

// 20:45:30 — an evening instant, because that is where 12h and 24h diverge.
const EVENING = new Date(2026, 0, 1, 20, 45, 30).getTime();

// Assertions are on PROPERTIES, not on exact strings: the separator and the
// AM/PM marker come from whatever locale the machine running this is set to,
// and a test that hard-codes "8:45:30 PM" fails on a box set to de-DE for a
// reason that has nothing to do with the code.

afterEach(() => {
  // The module holds one value for the whole app; a test that leaves it set
  // would decide the result of the next one.
  setDisplayHourCycle(DEFAULT_HOUR_CYCLE);
});

describe("the app's clock format", () => {
  test("defaults to 24-hour, which is what every fixed clock did before", () => {
    assert.equal(DEFAULT_HOUR_CYCLE, "24h");
    assert.equal(displayHourCycle(), "24h");
  });

  test("takes either cycle", () => {
    setDisplayHourCycle("12h");
    assert.equal(displayHourCycle(), "12h");
    setDisplayHourCycle("24h");
    assert.equal(displayHourCycle(), "24h");
  });

  test("junk from an older or newer build falls back rather than sticking", () => {
    // StageState is whatever the server sent. A downgrade, or a hand-edited
    // settings file, must not leave every clock in the app formatting on a
    // string nothing understands.
    setDisplayHourCycle("13h" as never);
    assert.equal(displayHourCycle(), "24h");
    setDisplayHourCycle(undefined);
    assert.equal(displayHourCycle(), "24h");
    setDisplayHourCycle(null);
    assert.equal(displayHourCycle(), "24h");
  });
});

describe("formatting a time of day", () => {
  test("24-hour shows the evening hour as 20 and no meridiem", () => {
    setDisplayHourCycle("24h");
    const out = formatClock(EVENING);
    assert.match(out, /20/, `expected a 24-hour reading, got ${out}`);
    assert.doesNotMatch(out, /[AP]\.?M\.?/i, `24-hour should carry no meridiem, got ${out}`);
  });

  test("12-hour shows the same instant as 8, with a meridiem", () => {
    setDisplayHourCycle("12h");
    const out = formatClock(EVENING);
    assert.match(out, /\b8\b/, `expected a 12-hour reading, got ${out}`);
    assert.match(out, /[AP]\.?M\.?/i, `12-hour should carry a meridiem, got ${out}`);
  });

  test("seconds are off unless asked for", () => {
    setDisplayHourCycle("24h");
    assert.doesNotMatch(formatClock(EVENING), /30/);
    assert.match(formatClock(EVENING, { seconds: true }), /30/);
  });

  test("an explicit cycle overrides the app setting", () => {
    // What the clock object in a custom layout relies on: a clock deliberately
    // set to 24h on a wall must not flip because the operator app changed.
    setDisplayHourCycle("12h");
    assert.match(formatClock(EVENING, { hourCycle: "24h" }), /20/);
  });

  test("a zone renders in that zone, not the viewer's", () => {
    setDisplayHourCycle("24h");
    const utc = formatClock(Date.UTC(2026, 0, 1, 3, 5, 0), { timeZone: "UTC" });
    assert.match(utc, /03/, `expected 03:05 UTC, got ${utc}`);
  });

  test("an unparseable time is blank, not 'Invalid Date'", () => {
    // These land in table cells and status lines, where blank reads as "not
    // known yet" — which is what it means.
    assert.equal(formatClock(null), "");
    assert.equal(formatClock(undefined), "");
    assert.equal(formatClock("not a date"), "");
    assert.equal(formatClock(Number.NaN), "");
  });

  test("a bad zone from a saved layout still prints a time", () => {
    // Intl THROWS on an unknown timeZone. A layout saved with a zone this
    // build's ICU does not carry would otherwise take down the whole panel.
    const out = formatClock(EVENING, { timeZone: "Mars/Olympus_Mons" });
    assert.notEqual(out, "", "a bad zone blanked the clock instead of falling back");
    assert.match(out, /20/);
  });
});

describe("the Intl options", () => {
  test("24-hour pads the hour so the width does not jump", () => {
    // 09:05 becoming 9:05 an hour later shifts everything beside it on a strip
    // that is meant to hold still.
    assert.equal(clockOptions({ hourCycle: "24h" }).hour, "2-digit");
    assert.equal(clockOptions({ hourCycle: "24h" }).hour12, false);
  });

  test("12-hour does not, because nobody writes 08:45 PM", () => {
    assert.equal(clockOptions({ hourCycle: "12h" }).hour, "numeric");
    assert.equal(clockOptions({ hourCycle: "12h" }).hour12, true);
  });

  test("no timeZone key at all when none was asked for", () => {
    // Passing `timeZone: undefined` is not the same as omitting it for every
    // Intl implementation; omit it properly.
    assert.ok(!("timeZone" in clockOptions({})));
    assert.equal(clockOptions({ timeZone: "UTC" }).timeZone, "UTC");
  });
});
