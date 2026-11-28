// The device routes while a config restore is landing.
//
// A restore holds every write to the screen bindings (pauseBindingWrites) until the
// process exits, so a claim, release or switch made in that window is refused. That
// refusal is "try again in a moment", a 503, never a 400 that reads as a mistake in
// the request. Driven through the routes and the dispatcher's own status rule.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { tempDataDir } from "../fixtures/temp-data-dir.js";

const dataDir = tempDataDir("su-devices-restoring-", { home: true });

const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { callRoute } = await import("./route-harness.js");
const { kioskDevicesStore, pauseBindingWrites } = await import("../kiosk-devices-store.js");
const { handlerErrorStatus } = await import("../remote-server.js");

let release: () => void = () => {};

before(async () => {
  await fs.writeFile(
    path.join(dataDir, "kiosk-devices.json"),
    JSON.stringify([
      { id: "mac-1", token: "", outputId: "wall", label: "Wall", macs: [], output: { kind: "display", name: "Display 1", port: "Display 1" } },
      { id: "mac-2", token: "pinned-secret", outputId: "side", label: "Side", macs: [], output: { kind: "display", name: "Display 2", port: "Display 2" } },
    ]),
  );
  await kioskDevicesStore.reload();
  release = await pauseBindingWrites();
});

after(async () => {
  release();
});

/** What the dispatcher answers for this request: the route's own status, or the one a throw maps to. */
async function status(route: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<{ status: number; error: string }> {
  try {
    const r = await callRoute(kioskDeviceRoutes, route, { method: "POST", body, headers });
    return { status: r.status ?? 0, error: String((r.json as { error?: string } | null)?.error ?? "") };
  } catch (err) {
    return { status: handlerErrorStatus(err), error: (err as Error).message };
  }
}

describe("device routes while a restore is landing", () => {
  for (const [route, body] of [
    ["/api/devices/claim", { deviceId: "pi-new", outputId: "wall" }],
    ["/api/devices/release", { deviceId: "mac-1" }],
    ["/api/devices/enabled", { deviceId: "mac-1", enabled: false }],
  ] as const) {
    it(`POST ${route} answers 503, try again, not 400`, async () => {
      const r = await status(route, body);
      assert.equal(r.status, 503, `answered ${r.status}: ${r.error}`);
      assert.match(r.error, /config restore is landing/);
    });
  }
});

describe("device writes that are not the operator's, while a restore is landing", () => {
  const onDisk = async () => JSON.parse(await fs.readFile(path.join(dataDir, "kiosk-devices.json"), "utf8")) as { id: string; token: string; enabled?: boolean }[];

  it("/enroll still sends a screen to its display, and leaves pinning its secret to the next enrolment", async () => {
    const r = await callRoute(kioskDeviceRoutes, "/enroll?device=mac-1&token=first-secret");
    assert.equal(r.status, 302, `a screen enrolling during a restore was not sent to its display: ${r.status} ${r.body.slice(0, 120)}`);
    assert.equal((await onDisk()).find((d) => d.id === "mac-1")?.token, "", "a pin was written over the restore");
  });

  it("a Mac's own switch, in its health report, answers 503 so it is sent again", async () => {
    const r = await status("/api/devices/mac-2/health", { enabled: false, changed: "c1" }, { "x-device-token": "pinned-secret" });
    assert.equal(r.status, 503, `answered ${r.status}: ${r.error}`);
    assert.equal((await onDisk()).find((d) => d.id === "mac-2")?.enabled, undefined, "the switch was written over the restore");
  });
});
