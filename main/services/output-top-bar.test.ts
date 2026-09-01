// A display's hidden top bar has to survive a restart and reach the kiosk.
//
// Two separate things can drop it, and only one of them is visible in the
// settings UI:
//
//  1. The flag is set on the in-memory Output but never written, so it is gone
//     the next time the server starts and the wall quietly grows its bar back
//     between one Sunday and the next.
//  2. The flag is stored fine but never copied onto ResolvedOutput — the
//     "per-output render descriptor so the kiosk needs no client-side joins"
//     the kiosk actually reads. Everything on the Screens page would look
//     right; every display would still draw the bar.
//
// So these drive the REAL controller against a real data directory and check
// both ends: what landed in settings.json, and what a kiosk would be handed.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-topbar-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");

type Mutable = {
  state: { views: View[]; outputs: Output[]; [k: string]: unknown };
  broadcast: () => void;
};

const ctl = stageController as unknown as Mutable;
// Only the socket is stubbed. recomputeResolved is deliberately left REAL —
// it is half of what this file is here to check.
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

describe("hiding a display's top bar", () => {
  it("reaches the descriptor the kiosk reads", async () => {
    assert.equal(resolvedFor("wall")?.hideTopBar, false, "a fresh output must default to showing its bar");
    await stageController.setOutputHideTopBar("wall", true);
    assert.equal(
      resolvedFor("wall")?.hideTopBar,
      true,
      "the flag never reached ResolvedOutput — every display would still draw the bar",
    );
  });

  it("survives a restart, because it is on disk and not just in memory", async () => {
    await stageController.setOutputHideTopBar("wall", true);
    const stored = await storedOutputs();
    assert.equal(
      stored.find((o) => o.id === "wall")?.hideTopBar,
      true,
      "the flag was not persisted — it would be gone at the next restart",
    );

    // A restart is the stored outputs being read back into a controller that
    // knows nothing. Recomputing from them is what the boot path does.
    ctl.state = { ...ctl.state, outputs: stored };
    recompute();
    assert.equal(resolvedFor("wall")?.hideTopBar, true, "the stored flag did not come back");
  });

  it("is per display: hiding one leaves the others alone", async () => {
    await stageController.setOutputHideTopBar("wall", true);
    assert.equal(resolvedFor("lobby")?.hideTopBar, false, "hiding one display's bar hid another's");
    const stored = await storedOutputs();
    assert.equal(stored.find((o) => o.id === "lobby")?.hideTopBar, undefined);
  });

  it("turns back on, and does not disturb the lock on the way", async () => {
    await stageController.setOutputLocked("wall", true);
    await stageController.setOutputHideTopBar("wall", true);
    assert.deepEqual(
      { locked: resolvedFor("wall")?.locked, hideTopBar: resolvedFor("wall")?.hideTopBar },
      { locked: true, hideTopBar: true },
      "the two flags must be independent",
    );
    await stageController.setOutputHideTopBar("wall", false);
    assert.deepEqual(
      { locked: resolvedFor("wall")?.locked, hideTopBar: resolvedFor("wall")?.hideTopBar },
      { locked: true, hideTopBar: false },
      "showing the bar again cleared the lock",
    );
  });

  it("refuses an output that does not exist rather than writing a ghost", async () => {
    await assert.rejects(
      () => stageController.setOutputHideTopBar("display-nowhere", true),
      /not found/i,
    );
  });
});
