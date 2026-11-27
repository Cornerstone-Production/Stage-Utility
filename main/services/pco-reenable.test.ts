// Switching Planning Center off and on again through integrationManager.setEnabled()
// (the route behind the tile's own switch) must leave the server with its stored
// credentials. Off clears them from the stage controller; on has to load them again,
// or every read answers "PCO not configured" while the tile's Test, which reads the
// stored credentials itself, still passes.
//
// Seeded directly, never through integrationManager.init(): the appliance coming up
// is not what is under test. The background check against Planning Center is
// stubbed, so nothing here dials out.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pco-reenable-"));

const { integrationManager } = await import("./integration-manager.js");
const { stageController } = await import("./stage-controller.js");
const { settingsStore } = await import("./settings-store.js");
const { secretsStore } = await import("./secrets.js");

const states = (integrationManager as unknown as { states: Map<string, unknown> }).states;

test("turning Planning Center back on loads its stored credentials again", async () => {
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
