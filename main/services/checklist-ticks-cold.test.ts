// Two ticks that arrive together are both saved, and a tick that fails to save
// never reads as done.
//
// Its own FILE, not another describe in checklist-ticks-store.test.ts, and that
// is the whole point of it. `node --test` gives each file its own process, so
// the store here has never been loaded — while that file calls init() in its
// first test and warms `loaded` for everything after it. Both bugs below are
// only reachable on a store that is still cold, so a guard written over there
// would pass no matter what this store did.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-ticks-cold-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { checklistTicksStore } = await import("./checklist-ticks-store.js");

const FILE = path.join(TMP, "checklist-ticks.json");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("a cold store does not lose a tick", () => {
  // MUST be the first test in this file: it is the only one that runs against a
  // store nobody has loaded yet, and every later call leaves it warm.
  it("saves BOTH of two ticks that arrive together", async () => {
    // Two rows ticked in the same second — one operator working down the list,
    // or two on different consoles. Both callers found `loaded === false`, both
    // ran init(), and init() reassigns the cache outright, so the second load
    // landed on top of the first tick and dropped it. Both HTTP calls returned
    // success and the job was quietly unticked again on the next render.
    await Promise.all([
      checklistTicksStore.set("77001122", "Production|Batteries fresh", true),
      checklistTicksStore.set("77001122", "Production|CO2 topped up", true),
    ]);

    const onDisk = JSON.parse(await fs.readFile(FILE, "utf8")) as Record<string, string[]>;
    assert.deepEqual(
      [...onDisk["77001122"]].sort(),
      ["Production|Batteries fresh", "Production|CO2 topped up"],
      "one of two concurrent ticks never reached the file",
    );
  });
});

describe("a tick that could not be saved is not shown as done", () => {
  it("leaves the row unticked when the write fails", async () => {
    // A write that genuinely fails, with no stubbing: replacing the file with a
    // DIRECTORY of the same name makes atomicWrite's rename(2) fail EISDIR on
    // every platform, which is the shape of the real failure (a full SD card)
    // without needing a full SD card.
    await fs.rm(FILE, { force: true });
    await fs.mkdir(FILE);

    await assert.rejects(
      () => checklistTicksStore.set("77003344", "Production|Batteries fresh", true),
      "the save failed and set() reported success",
    );

    assert.deepEqual(
      checklistTicksStore.get("77003344"),
      [],
      "the write failed but the tick still reads as done — somebody skips that job believing it was done",
    );
    assert.deepEqual(
      checklistTicksStore.all()["77003344"],
      undefined,
      "the failed tick reached the state broadcast",
    );
  });
});
