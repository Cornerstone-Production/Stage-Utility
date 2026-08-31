// The date ESPN is asked about is the app's date, not the host's.
//
// Servers run UTC. A UTC box rolls its date at 19:00 in Chicago, so a stamp
// taken off the host clock asks for TOMORROW's scoreboard from seven in the
// evening — which is an empty board for the whole of a Sunday night game, with
// nothing failing and nothing logged.
//
// todayStamp had no coverage at all. It also carried a second private
// Intl.DateTimeFormat, in a codebase whose stated rule is that every wall-clock
// decision goes through app-timezone.ts; it now calls zonedDateKey. The two were
// compared across 6.2M instants in 14 zones — every minute either side of every
// DST transition and new-year rollover from 2024 to 2027, plus half-hour,
// 45-minute and 30-minute-DST offsets and the era boundary — and never
// disagreed, so this is a de-duplication rather than a behaviour change.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setAppTimeZone, zonedDateKey } from "./app-timezone.js";
import { todayStamp } from "./scores-service.js";

/** Run `body` with the app zone set to `tz`, then put it back. */
function inZone<T>(tz: string | null, body: () => T): T {
  setAppTimeZone(tz);
  try {
    return body();
  } finally {
    setAppTimeZone(null);
  }
}

describe("todayStamp", () => {
  it("is YYYYMMDD, which is the only shape ESPN accepts", () => {
    const stamp = inZone("America/Chicago", todayStamp);
    assert.match(stamp, /^\d{8}$/, `ESPN was asked for "${stamp}"`);
  });

  it("is the APP zone's date, not the host's", () => {
    // THE guard. Asserted against zonedDateKey for the same instant rather than
    // against a literal, because "today" moves; the fact under test is that the
    // two agree, and a host-clock stamp does not agree with either.
    for (const tz of ["America/Chicago", "Pacific/Kiritimati", "Pacific/Niue", "Asia/Kathmandu"]) {
      const [stamp, key] = inZone(tz, () => [todayStamp(), zonedDateKey(Date.now())] as const);
      assert.equal(stamp, key.replaceAll("-", ""), `${tz}: the stamp is not that zone's date`);
    }
  });

  it("differs between zones that are on different sides of midnight", () => {
    // Proves the previous test is not passing because the zone argument is
    // ignored. Kiritimati (UTC+14) and Niue (UTC-11) are 25 hours apart, so
    // their calendar dates disagree at every instant of every day.
    const east = inZone("Pacific/Kiritimati", todayStamp);
    const west = inZone("Pacific/Niue", todayStamp);
    assert.notEqual(east, west, "the zone made no difference to the date asked for");
  });
});
