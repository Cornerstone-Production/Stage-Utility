import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appTimeZone,
  hostTimeZone,
  isFollowingHostTimeZone,
  isValidTimeZone,
  setAppTimeZone,
  zonedDateKey,
  zonedMinuteOfDay,
  zonedParts,
  startOfZonedDay,
  zonedTimeNear,
  zonedWallTime,
} from "./app-timezone.js";

// 18:30 America/Chicago on Sunday 2 Aug 2026 — 23:30 UTC the same day.
const EVENING = Date.parse("2026-08-02T23:30:00Z");
// 19:00 America/Chicago — 00:00 UTC on MONDAY. The instant the outage began.
const UTC_ROLLOVER = Date.parse("2026-08-03T00:00:00Z");

describe("zonedParts", () => {
  it("reports the local day, not the UTC one, after midnight UTC", () => {
    const chi = zonedParts(UTC_ROLLOVER, "America/Chicago");
    assert.equal(chi.day, 2, "still Sunday the 2nd in Chicago");
    assert.equal(chi.weekday, 0, "Sunday");
    assert.equal(chi.hour, 19);
    const utc = zonedParts(UTC_ROLLOVER, "UTC");
    assert.equal(utc.day, 3, "already Monday the 3rd in UTC");
    assert.equal(utc.weekday, 1, "Monday");
    assert.equal(utc.hour, 0);
  });

  it("gives midnight hour 0, not 24", () => {
    // The default hour12 cycle formats midnight as "24", which silently breaks
    // every `hour === 0` schedule comparison.
    assert.equal(zonedParts(Date.parse("2026-08-03T05:00:00Z"), "America/Chicago").hour, 0);
  });

  it("falls back to the host zone rather than throwing on a bad zone", () => {
    const p = zonedParts(EVENING, "Not/AZone");
    assert.ok(Number.isFinite(p.year) && p.year > 2000, "must still return usable parts");
  });
});

describe("zonedDateKey", () => {
  it("keeps an evening service on one date across the UTC rollover", () => {
    assert.equal(zonedDateKey(EVENING, "America/Chicago"), "2026-08-02");
    assert.equal(zonedDateKey(UTC_ROLLOVER, "America/Chicago"), "2026-08-02");
    // …which a UTC host would have split in two, and did.
    assert.equal(zonedDateKey(UTC_ROLLOVER, "UTC"), "2026-08-03");
  });

  it("zero-pads to a sortable YYYY-MM-DD", () => {
    assert.equal(zonedDateKey(Date.parse("2026-01-05T18:00:00Z"), "UTC"), "2026-01-05");
  });
});

describe("zonedMinuteOfDay", () => {
  it("measures from local midnight", () => {
    assert.equal(zonedMinuteOfDay(EVENING, "America/Chicago"), 18 * 60 + 30);
    assert.equal(zonedMinuteOfDay(EVENING, "UTC"), 23 * 60 + 30);
  });
});

describe("configuration", () => {
  it("follows the host until told otherwise, and reports that it is", () => {
    setAppTimeZone(null);
    assert.equal(isFollowingHostTimeZone(), true);
    assert.equal(appTimeZone(), hostTimeZone());
  });

  it("uses a configured zone, and ignores an invalid one instead of throwing", () => {
    setAppTimeZone("America/Chicago");
    assert.equal(appTimeZone(), "America/Chicago");
    // A typo in settings must not take the server down — fall back, don't crash.
    setAppTimeZone("Mars/Olympus_Mons");
    assert.equal(appTimeZone(), hostTimeZone());
    setAppTimeZone(null);
  });

  it("validates zone names", () => {
    assert.equal(isValidTimeZone("America/Chicago"), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone(""), false);
    assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  });
});

describe("startOfZonedDay", () => {
  // Named rather than written inline twice. gitleaks' generic-api-key rule reads
  // a high-entropy string literal sitting inside a call to something ending
  // "Key(" as a credential, and failed the secret scan on this line. A constant
  // is clearer anyway, and beats loosening the scanner repo-wide for a zone name.
  const ZONE = "America/Chicago";

  it("is the inverse of zonedDateKey", () => {
    for (const key of ["2026-01-15", "2026-07-04", "2026-11-01"]) {
      assert.equal(zonedDateKey(startOfZonedDay(key, ZONE), ZONE), key, key);
    }
  });

  it("lands on local midnight, not UTC midnight", () => {
    // 06:00Z in CST. A host-clock implementation returns 00:00Z and puts the
    // whole day six hours early.
    assert.equal(new Date(startOfZonedDay("2026-01-15", "America/Chicago")).toISOString(), "2026-01-15T06:00:00.000Z");
    assert.equal(new Date(startOfZonedDay("2026-07-15", "America/Chicago")).toISOString(), "2026-07-15T05:00:00.000Z");
  });

  it("uses the offset in force ON that date, not the one in force now", () => {
    // A single-pass implementation reads the offset at UTC midnight, which for a
    // spring-forward date can be the wrong side of the change.
    assert.equal(new Date(startOfZonedDay("2026-03-08", "America/Chicago")).toISOString(), "2026-03-08T06:00:00.000Z");
    assert.equal(new Date(startOfZonedDay("2026-03-09", "America/Chicago")).toISOString(), "2026-03-09T05:00:00.000Z");
  });

  it("handles a zone that has no midnight on the day the clocks jump", () => {
    // Santiago springs forward AT midnight: 2026-09-06 begins at 01:00 local.
    // Returning an instant on the 5th would put a whole day one square early.
    const t = startOfZonedDay("2026-09-06", "America/Santiago");
    assert.equal(zonedDateKey(t, "America/Santiago"), "2026-09-06");
  });

  it("refuses an instant, which would be a whole offset out", () => {
    assert.throws(() => startOfZonedDay("2026-01-15T00:00:00Z", "UTC"), /YYYY-MM-DD/);
  });
});

describe("zonedWallTime", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("reads a wall time on a date in the zone, to the second", () => {
    assert.equal(iso(zonedWallTime("2026-11-22", 18, 15, 33, "America/Chicago")), "2026-11-23T00:15:33.000Z");
    assert.equal(iso(zonedWallTime("2026-07-15", 9, 0, 0, "America/Chicago")), "2026-07-15T14:00:00.000Z");
  });

  it("takes the first of the two readings on a fall-back date", () => {
    // 1 Nov 2026: 01:30 happens at 06:30Z (CDT) and again at 07:30Z (CST).
    assert.equal(iso(zonedWallTime("2026-11-01", 1, 30, 0, "America/Chicago")), "2026-11-01T06:30:00.000Z");
    // East of UTC too, where both naive guesses land after the change: 02:30
    // happens at 00:30Z (CEST) and again at 01:30Z (CET) on 25 Oct 2026.
    assert.equal(iso(zonedWallTime("2026-10-25", 2, 30, 0, "Europe/Berlin")), "2026-10-25T00:30:00.000Z");
  });

  it("moves a reading in the skipped hour past the gap on a spring-forward date", () => {
    // 8 Mar 2026: 02:30 never happens in Chicago; the clocks go 01:59 -> 03:00.
    // 03:30 CDT, an hour of elapsed time after 01:30 CST.
    assert.equal(iso(zonedWallTime("2026-03-08", 2, 30, 0, "America/Chicago")), "2026-03-08T08:30:00.000Z");
  });
});

describe("zonedTimeNear", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  // 23:50 Chicago on Sat 21 Nov 2026.
  const LATE = Date.parse("2026-11-22T05:50:00Z");

  it("puts a time past midnight on the next day when that is nearer", () => {
    assert.equal(iso(zonedTimeNear(LATE, 0, 10, 0, "America/Chicago")), "2026-11-22T06:10:00.000Z");
  });

  it("keeps a time before midnight on the anchor's own day", () => {
    assert.equal(iso(zonedTimeNear(LATE, 23, 40, 0, "America/Chicago")), "2026-11-22T05:40:00.000Z");
  });

  it("goes back a day when that is nearer", () => {
    // 00:10 Chicago on the 22nd, corrected to 23:55: the evening before.
    const justAfter = Date.parse("2026-11-22T06:10:00Z");
    assert.equal(iso(zonedTimeNear(justAfter, 23, 55, 0, "America/Chicago")), "2026-11-22T05:55:00.000Z");
  });

  it("answers in the zone it is given, not the one it runs in", () => {
    // The same anchor and reading in two zones: 19:00 in Chicago is 01:00Z
    // nearest the anchor; 19:00 in UTC is the previous evening's.
    assert.equal(iso(zonedTimeNear(LATE, 19, 0, 0, "America/Chicago")), "2026-11-22T01:00:00.000Z");
    assert.equal(iso(zonedTimeNear(LATE, 19, 0, 0, "UTC")), "2026-11-21T19:00:00.000Z");
  });
});
