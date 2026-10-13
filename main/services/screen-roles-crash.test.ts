// A process that dies part-way through the screen-role upgrade must not turn a
// working control surface into a read-only screen on the next start.
//
// The upgrade writes the views, then the screens with their stored role removed,
// then records that it ran. A screen with no stored role reads as read-only on
// the first pass (that is what the old readers assumed), so the one moment that
// must never exist on disk is "roles removed, not yet recorded": the next start
// would treat every live screen as one that never had buttons and give it a wall
// copy. This boots the real controller on stores written the way the older build
// wrote them, makes the process "die" the instant after the screens are written
// (any write after that one is refused, so nothing it would have recorded lands),
// then boots again on what is on disk.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-screen-roles-crash-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { settingsStore } = await import("./settings-store.js");
const { screenIsControlSurface } = await import("../types/views.js");

const ctl = stageController as unknown as { broadcast: () => void; recomputeResolved: () => void; startUpdateChecks: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.startUpdateChecks = () => {};

const NOW = "2026-01-01T00:00:00.000Z";
const layout = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };

describe("a start that dies after the screens were written", () => {
  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("leaves every live screen live and every read-only screen read-only on the start after", async () => {
    await fs.writeFile(
      path.join(TMP, "settings.json"),
      JSON.stringify({
        appName: "Stage Utility",
        layoutDefaultsCleaned: true,
        cardHairlineRaised: true,
        outputs: [
          { id: "display-1", name: "Booth panel", viewId: "ctl-a", mode: "panel" },
          { id: "display-2", name: "Stage panel", viewId: "ctl-a", mode: "panel" },
          { id: "display-3", name: "Lobby TV", viewId: "ctl-a", mode: "display" },
          { id: "display-4", name: "Hall panel", viewId: "wall-a", mode: "panel" },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(TMP, "views.json"),
      JSON.stringify([
        { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW, layout },
        { id: "wall-a", name: "Hall loop", kind: "custom", surface: "display", createdAt: NOW, layout },
      ]),
      "utf8",
    );

    // The process dies once the screens are on disk: from then on a write that is not
    // part of the same patch never happens.
    const real = settingsStore.patch.bind(settingsStore);
    let screensWritten = false;
    settingsStore.patch = async (partial) => {
      if (screensWritten) throw new Error("the process died");
      const result = await real(partial);
      if ("outputs" in partial) screensWritten = true;
      return result;
    };
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      await stageController.init().catch(() => undefined);
      settingsStore.patch = real;
      await stageController.init();
    } finally {
      console.log = realLog;
      console.warn = realWarn;
      settingsStore.patch = real;
    }

    const { outputs, views } = stageController.getState();
    const live = (id: string) => screenIsControlSurface(outputs.find((o) => o.id === id)!, views);
    assert.deepEqual(
      ["display-1", "display-2", "display-3", "display-4"].map(live),
      [true, true, false, true],
      "a screen whose buttons worked was made read-only by the start after a crash, or a read-only one went live",
    );
    assert.equal(
      views.filter((v) => v.name.startsWith("Booth controls")).length,
      2,
      "the start after the crash made a second copy of the console",
    );
  });
});
