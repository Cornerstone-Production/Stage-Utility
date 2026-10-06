// The boot move of the renamed ServiceCue files, run through the real boot.
//
// Without it an automatic backup taken right after the first start on a new
// version omits all three ServiceCue files: a snapshot reads the data directory by
// the NEW names, and a store nobody has read yet still has its file under the old
// one. The unit tests of the move itself (servicecue-migration.test.ts) stay green
// with the call to it removed from boot, so this drives stageController.init() —
// the boot step server.ts calls, and the one slug-migration.test.ts drives too —
// on a data directory that holds only old-named files.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-servicecue-boot-"));
process.env.STAGE_UTILITY_DATA = dir;
process.env.HOME = path.join(dir, "home");

const { stageController } = await import("./stage-controller.js");
const { configSnapshot } = await import("./config-snapshot.js");

after(() => fs.rm(dir, { recursive: true, force: true }));

const LAYOUTS = [{ id: "svl-1", name: "Audio", order: 0, columnRoles: ["role-audio"] }];
const ROLES = [{ id: "role-audio", name: "Audio", members: ["Audio"] }];
const CONFIG = { serviceTypeIds: ["st-weekend"] };

describe("the first boot after the rename", () => {
  it("moves the old files before init returns, so a snapshot taken at once carries them", async () => {
    await fs.writeFile(path.join(dir, "scriptview-layouts.json"), JSON.stringify(LAYOUTS), "utf8");
    await fs.writeFile(path.join(dir, "scriptview-roles.json"), JSON.stringify(ROLES), "utf8");
    await fs.writeFile(path.join(dir, "scriptview-config.json"), JSON.stringify(CONFIG), "utf8");
    // What boot has on disk besides them, and nothing more.
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ layoutDefaultsCleaned: true }), "utf8");

    const ctl = stageController as unknown as {
      broadcast: () => void;
      recomputeResolved: () => void;
      startUpdateChecks: () => void;
    };
    ctl.broadcast = () => {};
    ctl.recomputeResolved = () => {};
    ctl.startUpdateChecks = () => {};

    await stageController.init();

    // The automatic backup's own call, before any ServiceCue store has been read.
    const bundle = await configSnapshot.build("Automatic");
    assert.deepEqual(bundle.files["servicecue-layouts.json"], LAYOUTS, "the backup is missing the layouts");
    assert.deepEqual(bundle.files["servicecue-roles.json"], ROLES, "the backup is missing the roles");
    assert.deepEqual(bundle.files["servicecue-config.json"], CONFIG, "the backup is missing the config");
    for (const old of ["scriptview-layouts.json", "scriptview-roles.json", "scriptview-config.json"]) {
      await assert.rejects(fs.access(path.join(dir, old)), `${old} is still there`);
    }
  });
});
