// Planning Center's credentials follow its saved switch. Off clears them from the stage
// controller; on, through integrationManager.setEnabled() (the route behind the tile's
// own switch), has to load them again, or every read answers "PCO not configured"
// while the tile's Test, which reads the stored credentials itself, still passes. A
// switch-off racing a switch-on, and a save made while it is off, leave it off.
//
// Seeded directly, never through integrationManager.init(), which starts reconnect
// timers that never let the process exit: boot's Planning Center step is its own
// method, startPco(), and is called directly. The check against Planning Center is
// stubbed, so nothing here dials out.
//
// Every test carries a timeout and the file stops the poller and the hourly refresh
// at the end, so a broken switch fails here instead of hanging a CI shard: a test
// waiting on a stub the code never reaches would otherwise wait for ever.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pco-reenable-"));

const { integrationManager } = await import("./integration-manager.js");
const { stageController } = await import("./stage-controller.js");
const { settingsStore } = await import("./settings-store.js");
const { secretsStore } = await import("./secrets.js");
const { pcoService } = await import("./pco-service.js");
const { livePoller } = await import("./live-poller.js");

const LIMIT = { timeout: 10_000 };

after(() => {
  livePoller.stop();
  stageController.stopAutoRefresh();
});

const states = (integrationManager as unknown as { states: Map<string, unknown> }).states;

test("turning Planning Center back on loads its stored credentials again", LIMIT, async () => {
  await settingsStore.patchIntegrationConfig("planning-center", { appId: "app-id-for-test" });
  await secretsStore.setSecrets("planning-center", { secret: "secret-for-test" });
  states.set("planning-center", { id: "planning-center", enabled: true, connection: "connected", message: null, config: {} });

  const im = integrationManager as unknown as { verifyPcoCredentials: () => Promise<boolean> };
  const realVerify = im.verifyPcoCredentials.bind(integrationManager);
  im.verifyPcoCredentials = async () => false;
  const calls: [string | null, string | null][] = [];
  const realSet = stageController.setPcoCredentials.bind(stageController);
  stageController.setPcoCredentials = (appId, secret, target) => {
    calls.push([appId, secret]);
    realSet(appId, secret, target);
  };
  try {
    await integrationManager.setEnabled("planning-center", false);
    assert.deepEqual(calls.at(-1), [null, null], "switched off, the stage controller holds no credentials");

    await integrationManager.setEnabled("planning-center", true);
    assert.deepEqual(
      calls.at(-1),
      ["app-id-for-test", "secret-for-test"],
      "switched back on, the stage controller was never given its credentials again",
    );
  } finally {
    stageController.setPcoCredentials = realSet;
    im.verifyPcoCredentials = realVerify;
  }
});

test("a switch-off that lands while a switch-on is still loading has the last word", LIMIT, async () => {
  const im = integrationManager as unknown as { verifyPcoCredentials: () => Promise<boolean> };
  const realVerify = im.verifyPcoCredentials.bind(integrationManager);
  im.verifyPcoCredentials = async () => false;
  const calls: [string | null, string | null][] = [];
  const realSet = stageController.setPcoCredentials.bind(stageController);
  stageController.setPcoCredentials = (appId, secret, target) => {
    calls.push([appId, secret]);
    realSet(appId, secret, target);
  };
  // The switch-on is held mid-load, reading the secret, while the switch-off runs.
  const slow = integrationManager as unknown as { getPcoSecret: () => Promise<string | null> };
  const realSecret = slow.getPcoSecret.bind(integrationManager);
  let entered!: () => void;
  const loading = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  slow.getPcoSecret = async () => {
    entered();
    await held;
    return realSecret();
  };
  try {
    const on = integrationManager.setEnabled("planning-center", true);
    await loading;
    const off = integrationManager.setEnabled("planning-center", false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([on, off]);
    assert.deepEqual(calls.at(-1), [null, null], "switched off last, the stage controller still holds credentials");
  } finally {
    stageController.setPcoCredentials = realSet;
    im.verifyPcoCredentials = realVerify;
    slow.getPcoSecret = realSecret;
  }
});

test("saving Planning Center's settings while it is switched off loads no credentials", LIMIT, async () => {
  await integrationManager.setEnabled("planning-center", false);
  const calls: [string | null, string | null][] = [];
  const realSet = stageController.setPcoCredentials.bind(stageController);
  stageController.setPcoCredentials = (appId, secret, target) => {
    calls.push([appId, secret]);
    realSet(appId, secret, target);
  };
  try {
    await integrationManager.setConfig("planning-center", { appId: "app-id-for-test" });
    assert.deepEqual(calls.at(-1), [null, null], "saved while off, the stage controller was given credentials");
  } finally {
    stageController.setPcoCredentials = realSet;
    // A save restarts the hourly refresh, whose timers would keep the test alive.
    stageController.stopAutoRefresh();
  }
});

test("a credential check that answers after Planning Center was switched off changes nothing", LIMIT, async () => {
  await settingsStore.patchIntegrationConfig("planning-center", { appId: "app-id-for-test" });
  await secretsStore.setSecrets("planning-center", { secret: "secret-for-test" });
  await integrationManager.setEnabled("planning-center", false);

  // PCO is held mid-answer: the switch-on's background check has asked, and the
  // switch-off lands before it hears back.
  let asked!: () => void;
  const asking = new Promise<void>((resolve) => (asked = resolve));
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const real = {
    list: pcoService.listServiceTypes,
    start: livePoller.start,
    refresh: stageController.refresh,
  };
  let starts = 0;
  let refreshes = 0;
  pcoService.listServiceTypes = (async () => {
    asked();
    await answered;
    return [{ id: "1", name: "Sunday" }];
  }) as typeof pcoService.listServiceTypes;
  livePoller.start = () => void starts++;
  stageController.refresh = (async () => {
    refreshes++;
    return stageController.getState();
  }) as typeof stageController.refresh;
  try {
    await integrationManager.setEnabled("planning-center", true);
    await asking;
    await integrationManager.setEnabled("planning-center", false);
    answer();
    // The late answer's tail, its dynamic import of the poller included, settles.
    for (let i = 0; i < 5; i++) {
      await (integrationManager as unknown as { pcoReconcile: Promise<void> }).pcoReconcile;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const tile = states.get("planning-center") as { connection: string };
    assert.notEqual(tile.connection, "connected", "a check that answered after the switch-off put the tile back to connected");
    assert.equal(starts, 0, "a check that answered after the switch-off started the live poller");
    assert.equal(refreshes, 0, "a check that answered after the switch-off refreshed the stage");
  } finally {
    pcoService.listServiceTypes = real.list;
    livePoller.start = real.start;
    stageController.refresh = real.refresh;
  }
});

test("a credential check that answers while Planning Center is still on connects it", LIMIT, async () => {
  // The other half of the test above: the switch check must not drop a good answer.
  await integrationManager.setEnabled("planning-center", false);
  const real = { list: pcoService.listServiceTypes, start: livePoller.start, refresh: stageController.refresh };
  let starts = 0;
  let refreshed!: () => void;
  const refreshing = new Promise<void>((resolve) => (refreshed = resolve));
  pcoService.listServiceTypes = (async () => [{ id: "1", name: "Sunday" }]) as typeof pcoService.listServiceTypes;
  livePoller.start = () => void starts++;
  stageController.refresh = (async () => {
    refreshed();
    return stageController.getState();
  }) as typeof stageController.refresh;
  try {
    await integrationManager.setEnabled("planning-center", true);
    await refreshing;
    assert.equal((states.get("planning-center") as { connection: string }).connection, "connected");
    assert.equal(starts, 1, "a good answer did not restart the live poller");
  } finally {
    pcoService.listServiceTypes = real.list;
    livePoller.start = real.start;
    stageController.refresh = real.refresh;
  }
});

test("a restart with Planning Center switched off comes back off", LIMIT, async () => {
  await settingsStore.patchIntegrationConfig("planning-center", { appId: "app-id-for-test" });
  await secretsStore.setSecrets("planning-center", { secret: "secret-for-test" });
  await settingsStore.patchIntegrationEnabled("planning-center", false);
  const im = integrationManager as unknown as { startPco: () => Promise<void>; verifyPcoCredentials: () => Promise<boolean> };
  const realVerify = im.verifyPcoCredentials;
  let checks = 0;
  im.verifyPcoCredentials = async () => {
    checks++;
    return false;
  };
  const calls: [string | null, string | null][] = [];
  const realSet = stageController.setPcoCredentials.bind(stageController);
  stageController.setPcoCredentials = (appId, secret, target) => {
    calls.push([appId, secret]);
    realSet(appId, secret, target);
  };
  try {
    await im.startPco();
    assert.deepEqual(calls, [[null, null]], "booted with the switch off, the stage controller was given the stored credentials");
    assert.equal(checks, 0, "booted with the switch off, Planning Center was asked to check the credentials");
  } finally {
    stageController.setPcoCredentials = realSet;
    im.verifyPcoCredentials = realVerify;
  }
});
