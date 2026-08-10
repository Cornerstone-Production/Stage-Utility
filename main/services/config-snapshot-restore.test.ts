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
