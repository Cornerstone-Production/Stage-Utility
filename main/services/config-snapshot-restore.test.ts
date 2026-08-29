// A failed config restore must not leave the box with nothing polling PCO.
//
// apply() stops the live poller and the stage controller's timers before laying
// a snapshot down — necessary, because the poller's next tick would otherwise
// read a still-warm settings cache and write it straight back over the file
// just restored. Only the SUCCESS path then exits the process. A write failure
// returned the error to the caller and left the appliance serving with every
// background writer stopped: stage displays frozen on their last state,
// recorders never ticking again, and nothing short of a restart to fix it.
//
// livePoller.start() is called from exactly one place — boot — so "stopped and
// not restarted" is permanent for the life of the process.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot, configFiles } = await import("./config-snapshot.js");
const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");

type Poller = { running: boolean; timer: ReturnType<typeof setTimeout> | null };
type Controller = {
  autoRefreshTimer: ReturnType<typeof setInterval> | null;
  updateCheckTimer: ReturnType<typeof setInterval> | null;
};
const poller = livePoller as unknown as Poller;
const controller = stageController as unknown as Controller;

/** The first allowlisted config filename — whichever it is, apply() writes it. */
const TARGET = configFiles()[0];

function snapshotOf(files: Record<string, unknown>) {
  return { kind: "stage-utility-config", version: 1, createdAt: "2026-07-26T00:00:00.000Z", files };
}

/** Stand the background writers up the way boot does, without booting. */
function pretendRunning() {
  poller.running = true;
  controller.autoRefreshTimer = setInterval(() => {}, 60_000);
  controller.updateCheckTimer = setInterval(() => {}, 60_000);
}

function quiet() {
  poller.running = false;
  if (poller.timer) clearTimeout(poller.timer);
  poller.timer = null;
  for (const k of ["autoRefreshTimer", "updateCheckTimer"] as const) {
    if (controller[k]) clearInterval(controller[k]!);
    controller[k] = null;
  }
}

describe("configSnapshot.apply — failure path", () => {
  beforeEach(() => {
    quiet();
    pretendRunning();
  });
  afterEach(async () => {
    quiet();
    await fs.rm(path.join(TMP, TARGET), { recursive: true, force: true });
  });

  it("restarts the background writers when a write fails", async () => {
    // A directory where the file belongs: the rename onto it cannot succeed, so
    // apply() throws part-way through with the writers already stopped.
    await fs.mkdir(path.join(TMP, TARGET, "occupied"), { recursive: true });

    await assert.rejects(
      () => configSnapshot.apply(snapshotOf({ [TARGET]: { anything: true } })),
      "a restore that cannot write must report the failure, not swallow it",
    );

    assert.equal(poller.running, true, "the live poller was left stopped — PCO is no longer polled");
    assert.notEqual(controller.autoRefreshTimer, null, "auto-refresh was left stopped");
    assert.notEqual(controller.updateCheckTimer, null, "update checks were left stopped");
  });

  it("does not start writers that were not running", async () => {
    // The undo restores what was there, not a default set. A box with
    // auto-refresh deliberately off must not have it switched on by a failed
    // restore.
    quiet();
    poller.running = true; // poller only
    await fs.mkdir(path.join(TMP, TARGET, "occupied"), { recursive: true });

    await assert.rejects(() => configSnapshot.apply(snapshotOf({ [TARGET]: { anything: true } })));

    assert.equal(poller.running, true);
    assert.equal(controller.autoRefreshTimer, null, "a failed restore turned auto-refresh ON");
    assert.equal(controller.updateCheckTimer, null, "a failed restore turned update checks ON");
  });

  it("leaves the writers stopped on success, because the process is about to exit", async () => {
    const applied = await configSnapshot.apply(snapshotOf({ [TARGET]: { anything: true } }));
    assert.deepEqual(applied, [TARGET]);
    assert.equal(poller.running, false, "a successful restore must NOT resume the poller");
    assert.equal(controller.autoRefreshTimer, null);
  });
});

// Id floors are the one thing in a config snapshot that must NOT go back to what
// the snapshot held.
//
// Everything else in a restore is the operator's setting, and putting it back is
// the point. A floor is not a setting — it is the record of which ids have been
// SPENT. A month-old snapshot carries a floor from before this month's views
// existed, so restoring it verbatim hands those deleted ids straight back out to
// the next thing created, and slots.json is keyed by output id with Pis,
// bookmarks and QR codes pointing at `/<id>`.
describe("a restore never lowers an id floor", () => {
  const SETTINGS = path.join(TMP, "settings.json");

  afterEach(async () => {
    quiet();
    await fs.rm(SETTINGS, { force: true });
    await fs.rm(path.join(TMP, "views.json"), { force: true });
  });

  async function applyFloors(live: unknown, snapshot: unknown): Promise<unknown> {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", idFloors: live }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", idFloors: snapshot } }));
    return (JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { idFloors?: unknown }).idFloors;
  }

  it("KEEPS THE LIVE FLOOR when the snapshot's is lower", async () => {
    // The whole finding: an old snapshot's floor would otherwise win, and the
    // ids issued between then and now would be handed out a second time.
    assert.deepEqual(
      await applyFloors({ view: 40, output: 12 }, { view: 9, output: 3 }),
      { view: 40, output: 12 },
      "the restore moved a floor backwards — every id issued since the snapshot can now be reissued",
    );
  });

  it("takes the snapshot's floor when it is higher", async () => {
    // Monotonic in both directions: a snapshot from another install with higher
    // floors is also a record of ids that were spent.
    assert.deepEqual(await applyFloors({ view: 4 }, { view: 30, output: 8 }), { view: 30, output: 8 });
  });

  it("restores everything else verbatim", async () => {
    // The exception is floors and only floors. A restore that quietly kept other
    // live values would not be a restore.
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", idFloors: { view: 40 } }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", idFloors: { view: 9 } } }));
    const written = JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { appName: string };
    assert.equal(written.appName, "Restored");
  });

  it("works with no live settings.json at all", async () => {
    // A restore onto a fresh install. Nothing to protect, and a missing file must
    // not fail the restore. `output` appears at its reserved minimum because
    // display-1 is the primary output and is never allocated.
    await fs.rm(SETTINGS, { force: true });
    await configSnapshot.apply(snapshotOf({ "settings.json": { idFloors: { view: 9 } } }));
    const written = JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { idFloors?: unknown };
    assert.deepEqual(written.idFloors, { view: 9, output: 2 });
  });

  // A pre-feature snapshot carries no floors at all, so the live floor — a number
  // belonging to the box being restored ONTO — would win by being the only
  // candidate, and land below every id in the bundle.
  //
  // Boot's seeding would repair that, but only at the NEXT boot, whenever that
  // happens. Kill the box in the seconds between apply() and the restart it
  // triggers and the low floor is what is on disk; a delete-then-create before
  // the box comes back would still reissue. A restore is exactly when someone is
  // most likely to be power-cycling a box, so the floor is made correct at the
  // instant it is written instead.
  it("RAISES THE FLOOR PAST THE IDS IT IS RESTORING, with no boot in between", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ idFloors: { view: 1, output: 2 } }), "utf8");
    await configSnapshot.apply(
      snapshotOf({
        // No idFloors: this snapshot predates the feature. Its ids run to 3.
        "settings.json": {
          outputs: [1, 2, 3].map((n) => ({ id: `display-${n}`, name: `D${n}`, viewId: null })),
        },
        "views.json": [1, 2, 3].map((n) => ({ id: `view-${n}`, name: `V${n}`, kind: "slots" })),
      }),
    );
    assert.deepEqual(
      (JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { idFloors?: unknown }).idFloors,
      { view: 4, output: 4 },
      "the floor landed below the ids the restore just wrote — until the next boot, deleting the highest and creating would reissue it",
    );
  });

  it("still lets a higher live floor win over the restored ids", async () => {
    // The three candidates are a max, not a precedence order. A live floor of 40
    // knows about ids this box spent and DELETED, which no file can show.
    await fs.writeFile(SETTINGS, JSON.stringify({ idFloors: { view: 40 } }), "utf8");
    await configSnapshot.apply(
      snapshotOf({
        "settings.json": {},
        "views.json": [{ id: "view-3", name: "V3", kind: "slots" }],
      }),
    );
    assert.deepEqual(
      (JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { idFloors?: { view?: number } }).idFloors?.view,
      40,
    );
  });
});
