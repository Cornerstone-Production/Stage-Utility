// A settings.json whose legacy displays list is not a list must not stop the
// server starting.
//
// stageController.init() turns the legacy list into views and screens on the
// first start that has no screens, and used to call `.map` on whatever the file
// held: `"displays": "junk"` threw out of init(), and server.ts awaits init()
// before it serves anything, so the server died on every boot. A restore now
// refuses that file (config-restore-checks.test.ts); this is a hand edit, which
// nothing refuses.
//
// The file is written before the controller is imported, so its first read is
// cold, as it is at boot.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-displays-boot-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");
await fs.writeFile(path.join(TMP, "settings.json"), JSON.stringify({ outputs: [], displays: "junk" }));
await fs.writeFile(path.join(TMP, "views.json"), "[]");

const { stageController } = await import("./stage-controller.js");
const ctl = stageController as unknown as { broadcast: () => void; recomputeResolved: () => void; startUpdateChecks: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.startUpdateChecks = () => {};

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

test("init() survives a legacy displays list that is not a list, and makes the default screen", async () => {
  await stageController.init();
  assert.deepEqual(stageController.getState().outputs.map((o) => o.id), ["display-1"]);
});
