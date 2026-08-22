// How a window reads on a schedule row.
//
// The summary is the only place an operator sees what a schedule DOES without
// opening it, so the two things it must never do are lie by omission and read as
// nonsense. "Thu 22:00-02:00" is the case that bites: taken at face value it is
// a four-hour window that can never open, when in fact it runs into Friday.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { describeWindow } from "./window-editor.js";

describe("how a window reads on a schedule row", () => {
  test("always says so plainly", () => {
    assert.equal(describeWindow({ kind: "always" }), "Always");
  });

  test("a weekly window names its day and hours", () => {
    assert.equal(
      describeWindow({ kind: "weekly", days: [0], start: "05:00", end: "13:00" }),
      "Sun 05:00-13:00",
    );
  });

  test("consecutive weekdays collapse to a range", () => {
    assert.equal(
      describeWindow({ kind: "weekly", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }),
      "Mon-Fri 09:00-17:00",
    );
  });

  test("every day says every day", () => {
    assert.equal(
      describeWindow({ kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00" }),
      "Every day 09:00-17:00",
    );
  });

  test("scattered days are listed rather than forced into a range", () => {
    assert.equal(
      describeWindow({ kind: "weekly", days: [0, 3], start: "09:00", end: "17:00" }),
      "Sun, Wed 09:00-17:00",
    );
  });

  test("days are read in week order, not the order they were clicked", () => {
    assert.equal(
      describeWindow({ kind: "weekly", days: [5, 1, 3], start: "09:00", end: "17:00" }),
      "Mon, Wed, Fri 09:00-17:00",
    );
  });

  test("a window that crosses midnight SAYS so", () => {
    const s = describeWindow({ kind: "weekly", days: [4], start: "22:00", end: "02:00" });
    assert.match(s, /Thu 22:00-02:00/);
    assert.match(s, /next day/i, "a midnight-crossing window reads as one that never opens");
  });

  test("a weekly window with no days says it will never run", () => {
    // Rather than reading as "Sun-Sat" or as an empty string, both of which look
    // like a schedule that works.
    assert.match(describeWindow({ kind: "weekly", days: [], start: "09:00", end: "17:00" }), /no days/i);
  });

  test("a date range names both ends", () => {
    assert.equal(
      describeWindow({ kind: "dates", from: "2026-12-01", to: "2026-12-25", start: "08:00", end: "20:00" }),
      "Dec 1 - Dec 25, 08:00-20:00",
    );
  });

  test("a date range with a weekly pattern mentions both", () => {
    assert.equal(
      describeWindow({ kind: "dates", from: "2026-12-01", to: "2026-12-25", days: [0], start: "08:00", end: "20:00" }),
      "Dec 1 - Dec 25, Sun 08:00-20:00",
    );
  });

  test("a one-off names its date", () => {
    assert.equal(
      describeWindow({ kind: "once", date: "2026-12-24", start: "15:00", end: "21:00" }),
      "Dec 24, 15:00-21:00",
    );
  });

  test("a PCO window names its padding", () => {
    assert.equal(
      describeWindow({ kind: "pco", serviceTypeId: "st-1", leadMinutes: 60, trailMinutes: 30, liveExtension: true }),
      "PCO plan times, 60 min before to 30 min after, held while live",
    );
  });

  test("and says nothing about live when the extension is off", () => {
    const s = describeWindow({
      kind: "pco", serviceTypeId: "st-1", leadMinutes: 60, trailMinutes: 30, liveExtension: false,
    });
    assert.ok(!/held while live/.test(s), "it claimed to hold while live when that is off");
    assert.match(s, /60 min before to 30 min after/);
  });
});
