// The flag the role migration records is written even when the migration changes
// no screen. Every other boot test here changes a screen, so the screens and the
// flag land in one patch and nothing exercises the flag going alone.
//
// A store whose screens carry no stored role and whose views are all wall views
// has nothing to take out and nothing to copy. If the flag is not written then,
// the next boot is still "the first pass", where a screen with no stored role is
// read as a read-only display: a console shown later by a screen added after the
// upgrade would be copied into a wall view instead of left live.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-screen-roles-flag-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { screenIsControlSurface } = await import("../types/views.js");
const { settingsStore } = await import("./settings-store.js");
const { viewsStore } = await import("./views-store.js");

const ctl = stageController as unknown as { broadcast: () => void; recomputeResolved: () => void; startUpdateChecks: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.startUpdateChecks = () => {};

const NOW = "2026-01-01T00:00:00.000Z";
const layout = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };
const wall = { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW, layout };
const pad = { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW, layout };

const readSettings = async () => JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as Record<string, unknown>;

describe("a boot that finds no screen to change", () => {
  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("still records that the roles come from the view, so a console added later stays live", async () => {
    await fs.writeFile(
      path.join(TMP, "settings.json"),
      JSON.stringify({
        appName: "Stage Utility",
        // Both earlier passes have run: only the flag under test is outstanding.
        layoutDefaultsCleaned: true,
        cardHairlineRaised: true,
        outputs: [{ id: "display-1", name: "Lobby TV", viewId: "wall-a" }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(TMP, "views.json"), JSON.stringify([wall]), "utf8");
    await stageController.init();
    assert.equal((await readSettings()).screenRolesFromView, true, "the flag was not written");

    // After the upgrade: a console, and a screen showing it with no stored role.
    // Written through the stores, which hold the files in memory by now.
    await viewsStore.save([...(await viewsStore.load()), pad as never]);
    const settings = await settingsStore.get();
    await settingsStore.patch({ outputs: [...settings.outputs, { id: "display-2", name: "Booth panel", viewId: "ctl-a" } as never] });
    await stageController.init();

    const { outputs, views } = stageController.getState();
    const booth = outputs.find((o) => o.id === "display-2")!;
    assert.equal(booth.viewId, "ctl-a", "a console shown by a screen added after the upgrade was copied into a wall view");
    assert.equal(screenIsControlSurface(booth, views), true, "the new screen is read-only");
    assert.equal(views.some((v) => v.name === "Booth controls (wall)"), false);
  });
});
