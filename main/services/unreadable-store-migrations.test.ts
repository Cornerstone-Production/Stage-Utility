// A store file that cannot be read at boot must not stop the server starting, and
// a migration that reads it must not write what it made of the defaults into
// another store.
//
// An unreadable store is served as its defaults, and the views-and-screens
// migrations read empty views as a first run: they would rebuild the screens from
// the legacy displays and save them. The views save is refused, and refused at a
// top-level await it would keep the server from starting; caught narrowly, the
// next write in the same pass would patch those rebuilt screens over the real
// ones in settings.json. This runs the real boot function against a views.json that is
// there and cannot be read, beside a settings.json holding real screens.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-unreadable-boot-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

// Written BEFORE anything is imported: the state a restarted server finds.
const SETTINGS = JSON.stringify(
  {
    outputs: [{ id: "lobby", name: "Lobby wall", viewId: "v-lobby" }],
    layoutDefaultsCleaned: true,
    cardHairlineRaised: true,
    screenRolesFromView: true,
  },
  null,
  2,
);
await fs.writeFile(path.join(TMP, "settings.json"), SETTINGS, "utf8");
// A directory where the file should be fails the read for root as well.
await fs.mkdir(path.join(TMP, "views.json"));
// A layout still naming its columns by category, which the layouts store
// migrates to roles on load, beside a roles file it cannot read.
const LAYOUTS = JSON.stringify([{ id: "l1", name: "Band", columns: ["Band", "Vocals"] }], null, 2);
await fs.writeFile(path.join(TMP, "servicecue-layouts.json"), LAYOUTS, "utf8");
await fs.mkdir(path.join(TMP, "servicecue-roles.json"));

const { stageController } = await import("./stage-controller.js");
const { viewsStore } = await import("./views-store.js");
const { serviceCueLayoutsStore } = await import("./servicecue-layouts-store.js");

type Stubbable = {
  broadcast: () => void;
  recomputeResolved: () => void;
  startUpdateChecks: () => void;
};
const ctl = stageController as unknown as Stubbable;
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
// Otherwise boot arms a timer that reaches the network for an update check.
ctl.startUpdateChecks = () => {};

after(async () => {
  stageController.pauseBackgroundWork();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("boot with views.json unreadable", () => {
  it("starts, and leaves settings.json exactly as it was", async () => {
    await stageController.init();
    assert.equal(viewsStore.unreadable()?.code, "EISDIR");
    assert.equal(
      await fs.readFile(path.join(TMP, "settings.json"), "utf8"),
      SETTINGS,
      "a start-up migration wrote over the real screens",
    );
    assert.deepEqual(
      stageController.getState().outputs.map((o) => o.id),
      ["lobby"],
      "the screens settings.json holds were not the ones served",
    );
  });
});

describe("ServiceCue layouts with servicecue-roles.json unreadable", () => {
  it("are served as they are, not migrated against no roles and saved", async () => {
    const layouts = await serviceCueLayoutsStore.load();
    assert.deepEqual(layouts.map((l) => l.id), ["l1"]);
    assert.equal(
      await fs.readFile(path.join(TMP, "servicecue-layouts.json"), "utf8"),
      LAYOUTS,
      "the layouts were rewritten against roles that could not be read",
    );
  });

  it("are still not migrated once the roles read again, since the roles save stays refused", async () => {
    await fs.rm(path.join(TMP, "servicecue-roles.json"), { recursive: true });
    await fs.writeFile(path.join(TMP, "servicecue-roles.json"), "[]", "utf8");
    // Migrating now would save the layouts and then have the roles save
    // refused: layouts pointing at roles that were never written.
    const layouts = await serviceCueLayoutsStore.load();
    assert.deepEqual(layouts.map((l) => l.id), ["l1"]);
    assert.equal(await fs.readFile(path.join(TMP, "servicecue-layouts.json"), "utf8"), LAYOUTS);
  });
});
