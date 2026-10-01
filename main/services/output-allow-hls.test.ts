// A screen's "keep it off HLS" switch has to survive a restart and reach the
// kiosk, exactly like hideTopBar (output-top-bar.test.ts) does — and for the
// same two reasons:
//
//  1. The flag is set on the in-memory Output but never written, so it is gone
//     at the next restart and a Pi that was struggling on HLS quietly grows
//     the HLS attempt back.
//  2. The flag is stored fine but never copied onto ResolvedOutput — the
//     descriptor the kiosk actually reads. The Screens page would show the
//     switch off; the display would still attempt HLS.
//
// So these drive the REAL controller against a real data directory and check
// both ends: what landed in settings.json, and what a kiosk would be handed.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-allowhls-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");

type Mutable = {
  state: { views: View[]; outputs: Output[]; [k: string]: unknown };
  broadcast: () => void;
};

const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};

function seed() {
  ctl.state = {
    ...ctl.state,
    views: [{ id: "v1", name: "Mic board", kind: "slots", createdAt: "" }] as View[],
    outputs: [
      { id: "wall", name: "Stage wall", viewId: "v1" },
      { id: "lobby", name: "Lobby", viewId: "v1" },
    ] as Output[],
  };
  recompute();
}

const recompute = () =>
  (stageController as unknown as { recomputeResolved: () => void }).recomputeResolved();

beforeEach(seed);

/** The outputs as they are actually on disk, read back rather than trusted. */
async function storedOutputs(): Promise<Output[]> {
  const raw = await fs.readFile(path.join(TMP, "settings.json"), "utf8");
  return (JSON.parse(raw) as { outputs?: Output[] }).outputs ?? [];
}

const resolvedFor = (id: string) =>
  (stageController.getState().resolvedByOutput ?? {})[id];

describe("keeping a screen off HLS", () => {
  it("defaults to allowed, and reaches the descriptor the kiosk reads", async () => {
    assert.equal(resolvedFor("wall")?.allowHls, true, "a fresh output must default to HLS allowed");
    await stageController.setOutputAllowHls("wall", false);
    assert.equal(
      resolvedFor("wall")?.allowHls,
      false,
      "the flag never reached ResolvedOutput — the display would still attempt HLS",
    );
  });

  it("survives a restart, because it is on disk and not just in memory", async () => {
    await stageController.setOutputAllowHls("wall", false);
    const stored = await storedOutputs();
    assert.equal(
      stored.find((o) => o.id === "wall")?.allowHls,
      false,
      "the flag was not persisted — it would be gone at the next restart",
    );

    // A restart is the stored outputs being read back into a controller that
    // knows nothing. Recomputing from them is what the boot path does.
    ctl.state = { ...ctl.state, outputs: stored };
    recompute();
    assert.equal(resolvedFor("wall")?.allowHls, false, "the stored flag did not come back");
  });

  it("is per display: turning one off leaves the other allowed", async () => {
    await stageController.setOutputAllowHls("wall", false);
    assert.equal(resolvedFor("lobby")?.allowHls, true, "turning one display's HLS off turned off another's");
    const stored = await storedOutputs();
    assert.equal(stored.find((o) => o.id === "lobby")?.allowHls, undefined);
  });

  it("turns back on, and does not disturb the top bar or the lock on the way", async () => {
    await stageController.setOutputLocked("wall", true);
    await stageController.setOutputHideTopBar("wall", true);
    await stageController.setOutputAllowHls("wall", false);
    assert.deepEqual(
      { locked: resolvedFor("wall")?.locked, hideTopBar: resolvedFor("wall")?.hideTopBar, allowHls: resolvedFor("wall")?.allowHls },
      { locked: true, hideTopBar: true, allowHls: false },
      "the three flags must be independent",
    );
    await stageController.setOutputAllowHls("wall", true);
    assert.deepEqual(
      { locked: resolvedFor("wall")?.locked, hideTopBar: resolvedFor("wall")?.hideTopBar, allowHls: resolvedFor("wall")?.allowHls },
      { locked: true, hideTopBar: true, allowHls: true },
      "allowing HLS again disturbed the lock or the top bar",
    );
  });

  it("refuses an output that does not exist rather than writing a ghost", async () => {
    await assert.rejects(
      () => stageController.setOutputAllowHls("display-nowhere", false),
      /not found/i,
    );
  });
});
