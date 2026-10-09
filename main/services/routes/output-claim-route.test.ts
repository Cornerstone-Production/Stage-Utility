// POST /api/devices/claim for an output of a Mac output helper, driven through the
// real route against the real stores: the binding it writes must keep the output
// (the port and card the screen is shown by), and the device it displaces must not
// keep showing a health reading that was about the screen it no longer has.
//
// The store's own claim() is tested beside it; these exist because the route is
// what calls it, and a route that forgot to pass `output` or to forget the health
// left every store test green.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-output-claim-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { callRoute } = await import("./route-harness.js");
const { kioskDevicesStore } = await import("../kiosk-devices-store.js");
const { recordSeen, recordHealth, healthList, resetKioskPresence } = await import("../kiosk-presence.js");

const MAC = "02:aa:00:bb:11:cc";
const output = { kind: "decklink" as const, name: "SDI 1 · Card A", port: "SDI 1", modes: ["1080p59.94", "720p60"] };
const REPORT = { fps: 59.94, repeated: 0.2, dropped: 0, at: 1 };

beforeEach(async () => {
  resetKioskPresence();
  await kioskDevicesStore.save([]);
});

const claim = (body: Record<string, unknown>) => callRoute(kioskDeviceRoutes, "/api/devices/claim", { method: "POST", body });

describe("claiming an output", () => {
  it("writes the output onto the stored binding", async () => {
    recordSeen({ id: "mac.sdi-1", macs: [MAC], hostname: "booth-mini", ip: "192.0.2.40", output });
    const r = await claim({ deviceId: "mac.sdi-1", outputId: "display-1" });
    assert.equal(r.status, 200, r.body);
    const stored = (await kioskDevicesStore.load()).find((d) => d.id === "mac.sdi-1");
    assert.deepEqual(stored?.output, output, "the binding lost which port it is");
    // And it is what GET /api/devices hands the page.
    const listed = (await callRoute(kioskDeviceRoutes, "/api/devices")).json as { bound: { id: string; output?: unknown }[] };
    assert.deepEqual(listed.bound.map((b) => [b.id, b.output]), [["mac.sdi-1", output]]);
  });

  it("forgets what the device it displaces reported", async () => {
    await kioskDevicesStore.save([
      { id: "old.sdi-1", token: "t", outputId: "display-1", macs: [MAC], output },
    ]);
    recordHealth("old.sdi-1", REPORT, "decklink");
    assert.deepEqual(healthList().map((h) => h.deviceId), ["old.sdi-1"]);

    recordSeen({ id: "new.sdi-1", macs: ["02:aa:00:bb:11:dd"], hostname: "spare-mini", ip: "192.0.2.41", output });
    const r = await claim({ deviceId: "new.sdi-1", outputId: "display-1" });
    assert.equal(r.status, 200, r.body);
    assert.equal((r.json as { displaced: string | null }).displaced, "old.sdi-1");
    assert.deepEqual(healthList(), [], "a displaced output still showed its old health");
  });
});
