// "Is a service under way?" — asked by everything that restarts this server, a
// Mac helper, or reloads the public ServiceCue page. Driven through the real
// singletons and the real wiring, so each consumer is held to the one answer:
//
//   the update lock       GET /api/update/lock (Update now, Restart, Switch track)
//   the auto-update       stageController.shouldAutoApply
//   the page deploy       deployerDeps.serviceActivity, what servicecue-deployer.ts reads
//   the machine updates   GET /api/machine-updates/check, for a Mac helper
//
// The bug this pins: Planning Center reports "preservice" whenever a plan has a
// service time and no item is live, days ahead. The auto-update, the page deploy
// and the machine updates counted that as live, so all three were held all week
// while the update lock (which never did) said nothing was live.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it, type TestContext } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-service-activity-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { serviceActivity, serviceActivityOf } = await import("./service-activity.js");
const { stageController } = await import("./stage-controller.js");
const { splRecorder } = await import("./spl-recorder.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { serviceWindow } = await import("./service-window.js");
const { zonedParts } = await import("./app-timezone.js");
const { deployerDeps } = await import("./servicecue-publisher-instance.js");
const { systemRoutes } = await import("./routes/system-routes.js");
const { kioskDeviceRoutes } = await import("./routes/kiosk-device-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { pkgVersion } = await import("./updater.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

type Ctl = { lastLive: unknown; state: Record<string, unknown>; pcoAppId: string | null; pcoSecret: string | null };
const ctl = stageController as unknown as Ctl;
const recorders = [splRecorder, attendanceRecorder, serviceTimelineRecorder] as unknown as { current: unknown }[];

const NOW = new Date();
const DAY = 24 * 60 * 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

/** Sunday's service, two days out: what Planning Center reported on a Friday. */
const COUNTDOWN_DAYS_AHEAD = {
  mode: "preservice", currentItemId: null, label: "Service starts", lengthSec: null, liveStartAt: null,
  targetAt: at(2 * DAY), serverNow: NOW.toISOString(), currentItemTitle: null, nextItemTitle: null,
  serviceTimeId: "st-1", serviceTimeStartsAt: at(2 * DAY),
};
/** The same countdown, minutes from the start. Still not a service under way: nothing is on air yet. */
const COUNTDOWN_MINUTES_AHEAD = { ...COUNTDOWN_DAYS_AHEAD, targetAt: at(10 * 60_000), serviceTimeStartsAt: at(10 * 60_000) };
const IN_AN_ITEM = {
  ...COUNTDOWN_DAYS_AHEAD, mode: "item", currentItemId: "item-1", label: "Welcome", liveStartAt: at(-60_000),
  targetAt: null, serviceTimeStartsAt: at(-10 * 60_000),
};
const OPEN_RECORD = { endedAt: null };
const CLOSED_RECORD = { endedAt: at(-60_000) };

let saved: { lastLive: unknown; state: Record<string, unknown>; pcoAppId: string | null; pcoSecret: string | null; current: unknown[] };

beforeEach(() => {
  saved = { lastLive: ctl.lastLive, state: ctl.state, pcoAppId: ctl.pcoAppId, pcoSecret: ctl.pcoSecret, current: recorders.map((r) => r.current) };
  // No Planning Center credentials: the service times count as known, so only "under way" can hold anything.
  ctl.pcoAppId = null;
  ctl.pcoSecret = null;
  ctl.state = {
    ...ctl.state,
    autoUpdate: { mode: "auto-full", dayOfWeek: null, hour: zonedParts(NOW.getTime()).hour },
    autoUpdateMachines: true,
  };
  serviceWindow.setWindows([]);
  for (const r of recorders) r.current = null;
});

afterEach(() => {
  ctl.lastLive = saved.lastLive;
  ctl.state = saved.state;
  ctl.pcoAppId = saved.pcoAppId;
  ctl.pcoSecret = saved.pcoSecret;
  recorders.forEach((r, i) => (r.current = saved.current[i]));
  serviceWindow.setWindows([]);
});

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** The machine updates log each decision; that line is theirs to test, not this file's. */
const quiet = (t: TestContext) => captureConsole(t, "log");

/** What each consumer makes of the server as it stands. */
async function consumers(): Promise<Record<string, boolean>> {
  const lock = await callRoute(systemRoutes, "/api/update/lock");
  assert.equal(lock.status, 200);
  const machine = await callRoute(kioskDeviceRoutes, `/api/machine-updates/check?machine=mac-1&platform=macos&have=0.0.1`);
  assert.equal(machine.status, 200, machine.body);
  const auto = stageController.shouldAutoApply(1, NOW);
  return {
    "update lock": (lock.json as { active: boolean }).active,
    "auto-update": !auto.apply && auto.why === "live",
    "page deploy": deployerDeps.serviceActivity().active,
    "machine update": (machine.json as { update: boolean }).update === false,
  };
}

/** Every consumer says `expected`, naming any that does not. */
async function allSay(expected: boolean, what: string): Promise<void> {
  const said = await consumers();
  const wrong = Object.entries(said).filter(([, v]) => v !== expected).map(([k]) => k);
  assert.deepEqual(wrong, [], `${what}: ${wrong.join(", ")} said ${expected ? "nothing is under way" : "a service is under way"} (${JSON.stringify(said)})`);
}

describe("whether a service is under way, as every restart and deploy asks it", () => {
  it("is not, for a preservice countdown two days ahead", async (t) => {
    quiet(t);
    ctl.lastLive = COUNTDOWN_DAYS_AHEAD;
    assert.deepEqual(serviceActivity(), { active: false, reasons: [] });
    await allSay(false, "a countdown two days ahead");
  });

  it("is not, for the countdown minutes before the start: nothing is on air until the first item", async (t) => {
    quiet(t);
    ctl.lastLive = COUNTDOWN_MINUTES_AHEAD;
    await allSay(false, "a countdown minutes ahead");
  });

  it("is not, with nothing live and no record open", async (t) => {
    quiet(t);
    ctl.lastLive = { ...COUNTDOWN_DAYS_AHEAD, mode: "none", targetAt: null };
    await allSay(false, "nothing live");
    ctl.lastLive = null;
    await allSay(false, "no reading yet");
  });

  it("is, while Planning Center is in an item", async (t) => {
    quiet(t);
    ctl.lastLive = IN_AN_ITEM;
    assert.deepEqual(serviceActivity(), { active: true, reasons: ["A PCO service is live"] });
    await allSay(true, "an item live");
  });

  it("is, while a recorder holds a record open after Planning Center has left its item", async (t) => {
    quiet(t);
    ctl.lastLive = COUNTDOWN_DAYS_AHEAD;
    for (const [i, reason] of ["SPL is recording", "Attendance is recording", "Service history is recording"].entries()) {
      recorders[i].current = OPEN_RECORD;
      assert.deepEqual(serviceActivity(), { active: true, reasons: [reason] });
      await allSay(true, reason);
      recorders[i].current = CLOSED_RECORD;
      await allSay(false, `${reason}, closed`);
    }
  });

  it("names every reason, in order", () => {
    assert.deepEqual(
      serviceActivityOf({ live: IN_AN_ITEM as never, spl: OPEN_RECORD, attendance: OPEN_RECORD, timeline: OPEN_RECORD }).reasons,
      ["A PCO service is live", "SPL is recording", "Attendance is recording", "Service history is recording"],
    );
  });

  it("is what the machine update reads, not merely the switch: a machine behind this server updates when nothing is under way", async (t) => {
    quiet(t);
    ctl.lastLive = COUNTDOWN_DAYS_AHEAD;
    const r = await callRoute(kioskDeviceRoutes, `/api/machine-updates/check?machine=mac-2&platform=macos&have=0.0.1`);
    assert.deepEqual(r.json, { version: pkgVersion(), update: true, reason: "Helper 0.0.1. Updating to " + pkgVersion() });
  });
});
