// A charger bay's reading reaches a browser when it changes, without anything
// structural changing with it.
//
// The charger widget and the Mic slots previews draw bays, and bays used to live
// only in stage state, which the device-status path re-resolves but does not
// re-send (it sends slots:devices and wireless:channels, and the second excludes
// chargers on purpose). So a pack charging from 50 to 60 percent reached no
// screen until somebody saved a layout.
//
// Driven through the real device-status path (applyDeviceStatus, its coalescing
// timer, its broadcasts), with a browser watching every channel.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { DeviceStatus } from "../types/devices.js";
import type { ChargerBayDTO } from "../types/state.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-charger-live-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { addBroadcastListener, setSubscriberCheck } = await import("./broadcaster.js");
const { CHARGER_BAYS_CHANNEL } = await import("../types/devices.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every bay list a browser was sent, on whichever channel carried it. */
const heard: { channel: string; bays: ChargerBayDTO[] }[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === CHARGER_BAYS_CHANNEL) heard.push({ channel, bays: payload as ChargerBayDTO[] });
  if (channel === "stage:state-changed") heard.push({ channel, bays: (payload as { chargerBays: ChargerBayDTO[] }).chargerBays });
});

const bay = (battery: number): DeviceStatus => ({
  channelId: "charger-1::2", name: "Bay 2", deviceType: "charger", online: true, rfBars: null, rfLevelDbm: null,
  battery, batteryMinutes: null, charging: true, frequencyLabel: null, audioLevel: null,
  cycles: 12, health: 98, tempC: 30, updatedAt: new Date().toISOString(),
});

describe("a charger bay's reading", () => {
  it("reaches a watching browser when it changes, with nothing structural changing", async () => {
    setSubscriberCheck(() => true);
    try {
      stageController.applyDeviceStatus("charger-1::2", bay(50));
      await sleep(250);
      heard.length = 0;
      stageController.applyDeviceStatus("charger-1::2", { ...bay(60), updatedAt: new Date().toISOString() });
      await sleep(250);
      const latest = heard.flatMap((h) => h.bays.filter((b) => b.id === "charger-1::2").map((b) => `${h.channel} ${b.battery}`));
      assert.ok(latest.some((l) => l.endsWith(" 60")), `the new reading reached no browser; heard: ${JSON.stringify(latest)}`);
      // Change-driven: the same reading again sends nothing.
      heard.length = 0;
      stageController.applyDeviceStatus("charger-1::2", { ...bay(60), updatedAt: new Date(Date.now() + 1000).toISOString() });
      await sleep(250);
      assert.deepEqual(heard.filter((h) => h.channel === CHARGER_BAYS_CHANNEL), [], "an unchanged reading was sent again");
    } finally {
      stageController.stopDeviceStatusUpdates();
    }
  });

  it("is not produced for nobody, even while a screen watches the rest", async () => {
    // A screen is watching state, so the device path runs; nobody names the bays.
    setSubscriberCheck((ch) => ch === "stage:state-changed");
    try {
      heard.length = 0;
      stageController.applyDeviceStatus("charger-1::2", bay(70));
      await sleep(250);
      assert.deepEqual(heard.filter((h) => h.channel === CHARGER_BAYS_CHANNEL), []);
    } finally {
      stageController.stopDeviceStatusUpdates();
    }
  });

  it("is served whole to a page that subscribes after the last change", () => {
    const bays = stageController.chargerBayStatuses();
    assert.deepEqual(bays.map((b) => [b.id, b.battery]), [["charger-1::2", 70]]);
  });
});
