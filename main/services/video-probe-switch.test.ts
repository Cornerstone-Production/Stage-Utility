// The Video feeds switch reaches the camera checks: turning it on or off
// through integrationManager.setEnabled() (the route behind the page's own
// switch) must change whether the probe scheduler asks any camera.
//
// Seeded directly, never through integrationManager.init(): the whole
// appliance coming up is not what is under test — see video-test-branch.test.ts.
// The relay lifecycle's own setEnabled is stubbed to a no-op: with a pull feed
// present, enabling it would try to download and start MediaMTX, which is a
// different test's business.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "video-probe-switch-"));

const { integrationManager } = await import("./integration-manager.js");
const { videoService, videoProbeDeps } = await import("./video/video-service.js");
const { relayLifecycle } = await import("./video/relay-lifecycle.js");

const states = (integrationManager as unknown as { states: Map<string, unknown> }).states;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("the switch, turned on and off through the integration manager, starts and stops the camera checks", async () => {
  states.set("video", { id: "video", enabled: false, connection: "disconnected", message: null, config: {} });
  const saved = { ...videoProbeDeps };
  const realSetEnabled = relayLifecycle.setEnabled.bind(relayLifecycle);
  relayLifecycle.setEnabled = () => {};
  const asked: string[] = [];
  videoProbeDeps.probe = async (target) => {
    asked.push(target.url);
    return { state: "ready" };
  };
  videoProbeDeps.setInterval = () => ({}) as NodeJS.Timeout;
  videoProbeDeps.clearInterval = () => {};
  videoProbeDeps.inDemand = () => true; // a Video feeds page is open
  try {
    const made = await videoService.addFeed({ name: "Switch cam", source: { kind: "pull", url: "rtsp://192.0.2.80:554/BOX", username: "" } });
    assert.ok(made.ok);
    videoService.subscriptionsChanged();
    await settle();
    assert.deepEqual(asked, [], "switch off: no camera asked");

    await integrationManager.setEnabled("video", true);
    await settle();
    assert.deepEqual(asked, ["rtsp://192.0.2.80:554/BOX"], "switch on: the page's cameras are asked at once");
    assert.equal(videoService.probeState().feeds["switch-cam"]?.state, "ready");

    await integrationManager.setEnabled("video", false);
    await settle();
    assert.deepEqual(videoService.probeState().feeds, {}, "switch off again: nothing is claimed about any camera");
  } finally {
    videoProbeDeps.inDemand = () => false;
    videoService.subscriptionsChanged();
    Object.assign(videoProbeDeps, saved);
    relayLifecycle.setEnabled = realSetEnabled;
    await videoService.removeFeed("switch-cam");
  }
});
