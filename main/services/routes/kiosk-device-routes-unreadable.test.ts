// The device routes while kiosk-devices.json cannot be read. The store serves its
// defaults so the server keeps running, and an empty list is the one answer these
// routes must not give: /enroll would hand a bound screen the unclaimed holding
// screen, and the Screens page would show nothing bound.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "su-devices-unreadable-"));
process.env.STAGE_UTILITY_DATA = dataDir;
process.env.HOME = path.join(dataDir, "home");

const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { callRoute } = await import("./route-harness.js");
const { kioskDevicesStore } = await import("../kiosk-devices-store.js");

before(async () => {
  // A directory where the file should be fails the read for root as well.
  await fs.mkdir(path.join(dataDir, "kiosk-devices.json"));
  await kioskDevicesStore.reload();
  assert.equal(kioskDevicesStore.unreadable()?.code, "EISDIR");
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("device routes with unreadable bindings", () => {
  for (const route of ["/enroll?device=pi-1&token=secret", "/api/devices", "/api/devices/for-output/wall"]) {
    it(`${route.split("?")[0]} fails rather than answering from an empty list`, async () => {
      await assert.rejects(callRoute(kioskDeviceRoutes, route), { name: "StoreReadError" });
    });
  }
});
