// A tick taken last night is still ticked after a restart.
//
// `checklistTicksStore.get` is synchronous and answers straight out of the
// module-level cache, so the cache has to be filled by the BOOT sequence — there
// is no await for it to hide behind. It was not: the only loads were the lazy
// ones inside set()/clear(), so the first render after every restart read an
// empty Map and reported every completed job as not done. It self-healed on the
// next tick, which is why it survived to a release.
//
// This runs the real boot function rather than reading stage-controller.ts for
// the word "init": a test that matched source text would be satisfied by a
// comment. `node --test` gives each file its own process, so the module cache
// here is genuinely cold and the store has never been loaded when init() runs —
// which the sibling checklist-ticks-store.test.ts cannot say, because it calls
// init() itself in its first test.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-ticks-boot-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

// Written BEFORE either module is imported, so this is the state a restarted
// server finds on disk and nothing in this process ever put it in memory.
const PLAN_ID = "88112233";
await fs.writeFile(
  path.join(TMP, "checklist-ticks.json"),
  JSON.stringify({ [PLAN_ID]: ["Production|Batteries fresh"] }),
  "utf8",
);

const { stageController } = await import("./stage-controller.js");
const { checklistTicksStore } = await import("./checklist-ticks-store.js");

type Stubbable = {
  broadcast: () => void;
  recomputeResolved: () => void;
  startUpdateChecks: () => void;
};
const ctl = stageController as unknown as Stubbable;
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
// Otherwise boot arms a 3-second timer that reaches the network for an update
// check and holds this process open past the last assertion.
ctl.startUpdateChecks = () => {};

after(async () => {
  stageController.pauseBackgroundWork();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("the checklist store is loaded at boot", () => {
  it("reports last night's ticks on the FIRST read after a restart", async () => {
    assert.deepEqual(
      checklistTicksStore.get(PLAN_ID),
      [],
      "the store was already warm, so this test could not prove anything",
    );

    await stageController.init();

    assert.deepEqual(
      checklistTicksStore.get(PLAN_ID),
      ["Production|Batteries fresh"],
      "boot never loaded checklist-ticks.json, so every completed job rendered not-done and was redone",
    );
  });
});
