// A backup taken before a screen's role came from its view must come back right.
//
// Restoring writes the backup's files and the server restarts, so what matters is
// that the load after a restore runs the same migration as the load after an
// upgrade. This puts a pre-upgrade bundle down through the real restore
// (configSnapshot.apply), then boots the real controller on what it wrote, in a
// process that has read none of it: the caches are cold, as they are after the
// restart a real restore triggers.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-screen-roles-restore-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot } = await import("./config-snapshot.js");
const { stageController } = await import("./stage-controller.js");
const { screenIsControlSurface } = await import("../types/views.js");

const ctl = stageController as unknown as { broadcast: () => void; recomputeResolved: () => void; startUpdateChecks: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.startUpdateChecks = () => {};

const NOW = "2026-01-01T00:00:00.000Z";
const layout = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };

describe("restoring a backup that stores a role on each screen", () => {
  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("is migrated by the load that follows it: a read-only screen stays read-only, a live one stays live", async () => {
    await configSnapshot.apply({
      kind: "stage-utility-config",
      version: 1,
      createdAt: NOW,
      files: {
        "settings.json": {
          appName: "Stage Utility",
          layoutDefaultsCleaned: true,
          cardHairlineRaised: true,
          outputs: [
            { id: "display-1", name: "Lobby TV", viewId: "ctl-a", mode: "display" },
            { id: "display-2", name: "Booth panel", viewId: "wall-a", mode: "panel" },
            { id: "display-3", name: "Stage panel", viewId: "ctl-a", mode: "panel" },
          ],
        },
        "views.json": [
          { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW, layout },
          { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW, layout },
        ],
      },
    });
    await stageController.init();

    const { outputs, views } = stageController.getState();
    const live = (id: string) => screenIsControlSurface(outputs.find((o) => o.id === id)!, views);
    assert.equal(live("display-1"), false, "a read-only screen went live on restore");
    assert.equal(live("display-2"), true, "a screen whose buttons worked lost them on restore");
    assert.equal(live("display-3"), true);
    assert.deepEqual(outputs.filter((o) => "mode" in o).map((o) => o.id), []);
    const disk = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as { outputs: object[] };
    assert.equal(disk.outputs.some((o) => "mode" in o), false, "the restored role is still on disk");
  });
});
