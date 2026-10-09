// GET /api/devices's `matches`: the "Looks like X, same MAC address" hint.
//
// The hint is for the hardware-came-back case: an unclaimed device shares a MAC
// with a claimed one that is offline, so it is probably that machine again. Every
// output of a Mac output helper shares the Mac's MAC, so without an exception each
// output reads as a look-alike of its own siblings the moment one is set up.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-device-matches-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { callRoute } = await import("./route-harness.js");
const { updateDevices } = await import("../kiosk-devices-store.js");
const { recordSeen, resetKioskPresence } = await import("../kiosk-presence.js");

const MAC = "02:aa:00:bb:11:cc";
const out = (name: string) => ({ kind: "decklink" as const, name, port: name });

beforeEach(() => resetKioskPresence());

async function matches(bound: { id: string; output?: ReturnType<typeof out> }[], seen: { id: string; output?: ReturnType<typeof out> }[]) {
  await updateDevices(() => bound.map((b) => ({ ...b, token: "t", outputId: `screen-${b.id}`, macs: [MAC] })));
  for (const s of seen) recordSeen({ ...s, macs: [MAC], ip: "192.0.2.40" });
  const r = await callRoute(kioskDeviceRoutes, "/api/devices");
  return (r.json as { matches: Record<string, string[]> }).matches;
}

describe("the same-MAC hint", () => {
  it("is not raised between outputs of one Mac", async () => {
    const m = await matches([{ id: "mac.sdi-1", output: out("SDI 1") }], [{ id: "mac.sdi-2", output: out("SDI 2") }]);
    assert.deepEqual(m, {}, "an output was flagged as a look-alike of its sibling");
  });

  it("is still raised between plain devices", async () => {
    const m = await matches([{ id: "pi-old" }], [{ id: "pi-new" }]);
    assert.deepEqual(m, { "pi-new": ["pi-old"] });
  });

  it("is raised for an output that may be a plain device coming back as the helper", async () => {
    const m = await matches([{ id: "mac-kiosk" }], [{ id: "mac.sdi-1", output: out("SDI 1") }]);
    assert.deepEqual(m, { "mac.sdi-1": ["mac-kiosk"] });
  });

  it("is still raised for a plain device on the MAC of a set-up output", async () => {
    const m = await matches([{ id: "mac.sdi-1", output: out("SDI 1") }], [{ id: "pi-new" }]);
    assert.deepEqual(m, { "pi-new": ["mac.sdi-1"] });
  });
});
