// What a restore does to this server's own id.
//
// Kiosks and Mac output helpers bind to a server by its serverId, so the id in
// settings.json decides which screens answer to this box. A restore writes
// settings.json back from the config, and the config's id is the id of the box
// it was saved on. Writing that verbatim onto a second box that also runs makes
// two servers answer discovery as one, and every screen bound to that id flips
// between them. Writing nothing, when the config carries no id, used to leave
// settings.json without one: the store has no default to fill it with, and the
// next start minted a new id, orphaning every screen bound to the old.
//
// Driven through apply() and the files on disk, the way a restore really lands.

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-id-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot } = await import("./config-snapshot.js");
const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");

const SETTINGS = path.join(TMP, "settings.json");
const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";

function snapshotOf(files: Record<string, unknown>) {
  return { kind: "stage-utility-config", version: 1, createdAt: "2026-11-11T00:00:00.000Z", files };
}

/** apply() pauses the poller and the controller's timers and, on success, leaves
 *  them paused because the process is about to exit. A test process is not. */
function quiet() {
  const poller = livePoller as unknown as { running: boolean; timer: ReturnType<typeof setTimeout> | null };
  poller.running = false;
  if (poller.timer) clearTimeout(poller.timer);
  poller.timer = null;
  const c = stageController as unknown as Record<string, ReturnType<typeof setInterval> | null>;
  for (const k of ["autoRefreshTimer", "updateCheckTimer"]) {
    if (c[k]) clearInterval(c[k]!);
    c[k] = null;
  }
}

async function writtenServerId(): Promise<unknown> {
  return (JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { serverId?: unknown }).serverId;
}

describe("a restore of a config with no server id", () => {
  afterEach(async () => {
    quiet();
    await fs.rm(SETTINGS, { force: true });
  });

  it("KEEPS THIS SERVER'S ID when the config has no serverId key", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored" } }));
    assert.equal(
      await writtenServerId(),
      OWN,
      "the restore dropped this server's id: the next start mints a new one and every screen bound here is orphaned",
    );
  });

  it("keeps this server's id when the config's serverId is null", async () => {
    // A config saved on a box that never switched discovery on.
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", serverId: null } }));
    assert.equal(await writtenServerId(), OWN);
  });

  it("still restores the rest of settings.json", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored" } }));
    assert.equal((JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { appName: string }).appName, "Restored");
  });

  it("writes no id onto a box that has none", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live" }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored" } }));
    assert.equal(await writtenServerId() ?? null, null);
  });
});
