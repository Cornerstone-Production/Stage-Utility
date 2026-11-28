// attendanceStats reads the figures a History row, Trends and the exports show.
// A record taken whole by an import is not validated, so a reading that is not
// a number can be on disk; it is passed over rather than let into a figure,
// where a string turns Math.max into concatenation and a missing value into NaN.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { attendanceStats } from "./attendance-aggregate.js";

test("a reading that is not a number is passed over, and no figure is poisoned", () => {
  const stats = attendanceStats([
    { t: "2026-10-04T15:00:00.000Z", attendance: 10, occupancy: 300 },
    { t: "2026-10-04T15:01:00.000Z", attendance: "40" as unknown as number, occupancy: undefined as unknown as number },
    { t: "2026-10-04T15:02:00.000Z", attendance: 20, occupancy: 280 },
    { t: "2026-10-04T15:03:00.000Z", attendance: Number.NaN, occupancy: 290 },
  ]);
  assert.deepEqual(stats, { peakAttendance: 20, peakOccupancy: 300, minOccupancy: 280, lastAttendance: 20, lastOccupancy: 290 });
});

test("figures come from the service proper, falling back to every sample", () => {
  const ramp = { t: "2026-10-04T14:50:00.000Z", attendance: 0, occupancy: 5, phase: "pre" as const };
  const svc = { t: "2026-10-04T15:00:00.000Z", attendance: 30, occupancy: 250 };
  assert.equal(attendanceStats([ramp, svc]).minOccupancy, 250, "the ramp dragged the floor");
  assert.equal(attendanceStats([ramp]).minOccupancy, 5, "a ramp-only record has no figures at all");
});
