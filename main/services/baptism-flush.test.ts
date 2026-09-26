// baptismTimerService.flush() — the in-progress state, saved now.
//
// commit() saves up to 800ms after a press. A server stopped inside that window
// came back to the state before the press, and a test that saved a record of
// its own had the pending write land on top of it. flush() writes at once and
// cancels the pending one; shutdown and those tests await it. Both halves are
// pinned against the real store: the write has to be there without waiting, and
// nothing may land afterwards.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-flush-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import type { BaptismState } from "../types/stage.js";

const { baptismTimerService: timer } = await import("./baptism-timer-service.js");
const { baptismStore } = await import("./baptism-store.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("flush()", () => {
  it("without a flush, the debounced save still lands on its own", async () => {
    timer.reset();
    await timer.flush();
    timer.start();
    assert.notEqual((await baptismStore.loadCurrent())?.phase, "testimony", "sanity: the press is not saved at once");
    // Waits on the write, not a fixed time, so a loaded machine cannot fail it.
    let phase: string | undefined;
    for (let i = 0; i < 60 && phase !== "testimony"; i++) {
      await sleep(50);
      phase = (await baptismStore.loadCurrent())?.phase;
    }
    assert.equal(phase, "testimony", "commit()'s debounced save never landed");
    timer.reset();
    await timer.flush();
  });

  it("saves a press at once, not when the debounce fires", async () => {
    timer.reset();
    await timer.flush();
    timer.start();
    await timer.flush();
    assert.equal((await baptismStore.loadCurrent())?.phase, "testimony", "the press is on disk the moment flush() resolves");
    timer.reset();
    await timer.flush();
  });

  it("leaves no pending save to land on a record written after it", async () => {
    timer.reset();
    timer.start(); // arms commit()'s debounced save
    await timer.flush();
    const mine = { ...timer.getState(), serviceTitle: "written after the flush" } as BaptismState;
    await baptismStore.saveCurrent(mine);
    await sleep(900); // past the debounce the flush cancelled
    assert.equal(
      (await baptismStore.loadCurrent())?.serviceTitle,
      "written after the flush",
      "a save still pending from the press landed on top of the later write",
    );
    timer.reset();
    await timer.flush();
  });
});
