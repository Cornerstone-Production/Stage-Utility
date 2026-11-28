// The SenSource suites' shared reset must leave nothing of a previous case
// behind. It drives the service's real configure(); a hand-written list of
// fields missed the SafeSpace state, the attendance anchor and the poll epoch,
// which a later case would have inherited by test order.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-sensource-stub-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { sensourceService } = await import("../sensource-service.js");
const { resetService, stubSchedulers } = await import("./sensource-stub.js");

type Leaky = {
  attendanceAnchor: unknown;
  pollEpoch: number;
  safeSpaceAt: unknown;
  veaOccupancy: number | null;
  attendanceInFlight: boolean;
  running: boolean;
};
const svc = sensourceService as unknown as Leaky;

const CFG = {
  clientId: "c",
  clientSecret: "s",
  apiToken: null,
  pollSeconds: 15,
  attendancePollSeconds: 15,
  locationId: null,
  zoneIds: [],
  safeSpaceId: null,
  safeSpaceEnabled: false,
  safeSpacePollSeconds: 10,
};

test("resetService clears what a previous case left in the service", () => {
  stubSchedulers(sensourceService);
  svc.attendanceAnchor = { at: 1 };
  svc.safeSpaceAt = { occupancy: 9, at: 1 };
  svc.veaOccupancy = 9;
  svc.attendanceInFlight = true;
  const epoch = svc.pollEpoch;

  resetService(sensourceService, CFG);

  assert.equal(svc.attendanceAnchor, null, "the attendance anchor leaked into the next case");
  assert.equal(svc.safeSpaceAt, null, "SafeSpace's last reading leaked into the next case");
  assert.equal(svc.veaOccupancy, null, "Vea's occupancy leaked into the next case");
  assert.equal(svc.attendanceInFlight, false, "a runtime flag leaked into the next case");
  assert.equal(svc.pollEpoch, epoch + 1, "an in-flight poll from the last case was not cut off");
  assert.equal(svc.running, true);
});
