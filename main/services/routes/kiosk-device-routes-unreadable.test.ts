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
  // The first /enroll in this file, so it is the one that logs.
  it("/enroll answers a page that reloads itself, so a kiosk recovers once the file reads", async () => {
    const lines: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
    let r;
    try {
      r = await callRoute(kioskDeviceRoutes, "/enroll?device=pi-1&token=secret");
      for (let i = 0; i < 2; i++) await callRoute(kioskDeviceRoutes, "/enroll?device=pi-2");
    } finally {
      console.warn = real;
    }
    assert.equal(r.status, 503);
    assert.match(r.headers["content-type"] ?? "", /text\/html/);
    assert.match(r.body, /Cannot read the screen list/);
    assert.match(r.body, /location\.reload\(\)/);
    assert.ok(!r.body.includes("secret"), "the page carried the device's token");
    assert.equal(lines.length, 1, `three reloads logged ${lines.length} lines: ${lines.join(" | ")}`);
    assert.match(lines[0], /^\[kiosk\] /);
  });

  for (const route of ["/api/devices", "/api/devices/for-output/wall"]) {
    it(`${route.split("?")[0]} fails rather than answering from an empty list`, async () => {
      await assert.rejects(callRoute(kioskDeviceRoutes, route), { name: "StoreReadError" });
    });
  }

  // A refusal the operator can act on is a 400; a store the server cannot read is
  // a 503 (the dispatcher answers a thrown StoreReadError so), not a 400 that
  // reads as a mistake in the request.
  for (const [route, body] of [
    ["/api/devices/release", { deviceId: "pi-1" }],
    ["/api/devices/claim", { deviceId: "pi-1", outputId: "wall" }],
  ] as const) {
    it(`POST ${route} fails with the read error rather than answering 400`, async () => {
      await assert.rejects(callRoute(kioskDeviceRoutes, route, { method: "POST", body }), { name: "StoreReadError" });
    });
  }
});
