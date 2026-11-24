// A restore's screen bindings are not written back over by a probe or heartbeat.
//
// A restore writes kiosk-devices.json to disk itself, while kioskDevicesStore's cache
// keeps the bindings from before it, and the process exits ~1.2 s after the restore
// answers. A bound screen heartbeats every twenty seconds and probes every two; one
// landing in that window read the store's cache and wrote the old bindings straight
// back over the restored file, with the restore reporting success. Restores now hold
// every write to the bindings (pauseBackgroundWriters) once any in flight is done.
//
// Its own file: a successful apply() leaves the hold on, because the real process exits.
// Driven through apply(), the heartbeat's own writer and the files on disk.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-bindings-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot } = await import("./config-snapshot.js");
const { kioskDevicesStore, recordDisplayScreen, updateDevices, touch, BindingsRestoring } = await import("./kiosk-devices-store.js");
const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");

const SETTINGS = path.join(TMP, "settings.json");
const DEVICES = path.join(TMP, "kiosk-devices.json");
const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";

const before = [{ id: "dev-before", token: "", outputId: "display-1", label: "Before", macs: [] }];
const restored = [{ id: "dev-restored", token: "", outputId: "display-2", label: "Restored", macs: [] }];

after(async () => {
  const poller = livePoller as unknown as { running: boolean; timer: ReturnType<typeof setTimeout> | null };
  poller.running = false;
  if (poller.timer) clearTimeout(poller.timer);
  const c = stageController as unknown as Record<string, ReturnType<typeof setInterval> | null>;
  for (const k of ["autoRefreshTimer", "updateCheckTimer"]) if (c[k]) clearInterval(c[k]!);
  await fs.rm(TMP, { recursive: true, force: true });
});

const onDisk = async () => (JSON.parse(await fs.readFile(DEVICES, "utf8")) as { id: string }[]).map((d) => d.id);

describe("a restore landing while a bound screen checks in", () => {
  it("keeps the restored bindings on disk through a heartbeat and a probe's write", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await fs.writeFile(DEVICES, JSON.stringify(before), "utf8");
    // Warm, as on a running server: every probe has read it since boot.
    assert.deepEqual((await kioskDevicesStore.load()).map((d) => d.id), ["dev-before"]);

    // The same server's own backup, so its bindings are restored rather than released.
    await configSnapshot.apply({
      kind: "stage-utility-config",
      version: 1,
      createdAt: "2026-11-24T00:00:00.000Z",
      files: { "settings.json": { appName: "Restored", serverId: OWN }, "kiosk-devices.json": restored },
    });
    assert.deepEqual(await onDisk(), ["dev-restored"]);

    // The heartbeat of the screen bound before, reporting a new size: a real change.
    const failed = await recordDisplayScreen("display-1", "dev-before", { w: 1920, h: 1080, dpr: 1 });
    assert.equal(failed, null);
    assert.deepEqual(await onDisk(), ["dev-restored"], "a heartbeat wrote the pre-restore bindings back over the restored file");

    // What a probe's touch (and every route) writes through.
    await assert.rejects(
      () => updateDevices((cur) => touch(cur, "dev-before", { hostname: "new-name", now: Date.now() })),
      BindingsRestoring,
    );
    assert.deepEqual(await onDisk(), ["dev-restored"], "a probe wrote the pre-restore bindings back over the restored file");
  });
});
