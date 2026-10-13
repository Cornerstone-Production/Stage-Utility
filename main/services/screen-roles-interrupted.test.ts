// A process that dies after the upgrade saved a copy of a view and before it
// pointed the screen at it must not make a second copy on the start after.
//
// The views are saved first and the screens second, so that window leaves the copy
// on disk, shown by no screen, with the screens still carrying their stored role.
// The pass that runs again plans the same copy. This boots the real controller on
// an old-format store, makes the process "die" before the screens are written, then
// boots again on what is on disk and counts the views.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-screen-roles-interrupted-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { settingsStore } = await import("./settings-store.js");
const { screenIsControlSurface, viewSurface } = await import("../types/views.js");

const ctl = stageController as unknown as { broadcast: () => void; recomputeResolved: () => void; startUpdateChecks: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.startUpdateChecks = () => {};

const NOW = "2026-01-01T00:00:00.000Z";
const layout = (id: string) => ({
  version: 1,
  canvas: { width: 1920, height: 1080, background: null },
  objects: [{ id: `${id}-clock`, x: 0, y: 0, w: 10, h: 10, z: 0, config: { type: "clock" } }],
});

describe("a start that dies after saving a copy, before the screens are written", () => {
  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("reuses the copy it left, says so, and makes no second one", async () => {
    await fs.writeFile(
      path.join(TMP, "settings.json"),
      JSON.stringify({
        appName: "Stage Utility",
        layoutDefaultsCleaned: true,
        cardHairlineRaised: true,
        outputs: [
          { id: "display-1", name: "Lobby TV", viewId: "ctl-a", mode: "display" },
          { id: "display-2", name: "Booth panel", viewId: "ctl-a", mode: "panel" },
          { id: "display-3", name: "Hall panel", viewId: "wall-a", mode: "panel" },
          { id: "display-4", name: "Hall TV", viewId: "wall-a", mode: "display" },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(TMP, "views.json"),
      JSON.stringify([
        { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW, layout: layout("ctl-a") },
        { id: "wall-a", name: "Hall loop", kind: "custom", surface: "display", createdAt: NOW, layout: layout("wall-a") },
      ]),
      "utf8",
    );

    // Dies before the screens are written: the views are already saved.
    const real = settingsStore.patch.bind(settingsStore);
    settingsStore.patch = async (partial) => {
      if ("outputs" in partial) throw new Error("the process died");
      return real(partial);
    };
    const lines: string[] = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.warn = () => {};
    try {
      await assert.rejects(() => stageController.init(), /the process died/);
      const savedViews = JSON.parse(await fs.readFile(path.join(TMP, "views.json"), "utf8")) as { name: string }[];
      assert.deepEqual(
        savedViews.map((v) => v.name).filter((n) => /\((wall|control surface)\)$/.test(n)).sort(),
        ["Booth controls (wall)", "Hall loop (control surface)"],
        "the interrupted start was meant to leave its two copies on disk",
      );
      settingsStore.patch = real;
      lines.length = 0;
      await stageController.init();
    } finally {
      console.log = realLog;
      console.warn = realWarn;
      settingsStore.patch = real;
    }

    const { outputs, views } = stageController.getState();
    assert.deepEqual(
      views.map((v) => v.name).filter((n) => n !== "Home").sort(),
      ["Booth controls", "Booth controls (wall)", "Hall loop", "Hall loop (control surface)"],
      "the start after the crash made a second copy",
    );
    const live = (id: string) => screenIsControlSurface(outputs.find((o) => o.id === id)!, views);
    assert.deepEqual(["display-1", "display-2", "display-3", "display-4"].map(live), [false, true, true, false]);
    const wall = views.find((v) => v.name === "Booth controls (wall)")!;
    assert.equal(viewSurface(wall), "display");
    assert.equal(outputs.find((o) => o.id === "display-1")!.viewId, wall.id);
    assert.deepEqual(
      lines.filter((l) => l.startsWith("[screens] reused")),
      [
        '[screens] reused the copy left by an interrupted upgrade: "Booth controls (wall)"',
        '[screens] reused the copy left by an interrupted upgrade: "Hall loop (control surface)"',
      ],
    );
    assert.match(lines.find((l) => l.includes("role from view:")) ?? "", /0 copies made/);
  });
});
