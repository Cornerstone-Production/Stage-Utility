// A display's ServiceCue text size is kept by the server, per output.
//
// The size has to land in settings.json (the operator's config store, which is
// what a backup carries and a replacement device inherits) and on ResolvedOutput,
// the descriptor every display AND every Screens preview of it reads. Driven
// against the real controller and a real data directory, checking both ends.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { captureConsole } from "./fixtures/capture-console.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-textsize-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");

type Mutable = {
  state: { views: View[]; outputs: Output[]; [k: string]: unknown };
  broadcast: () => void;
};

const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};

const recompute = () => (stageController as unknown as { recomputeResolved: () => void }).recomputeResolved();

beforeEach(() => {
  ctl.state = {
    ...ctl.state,
    views: [{ id: "v1", name: "Rundown", kind: "script", createdAt: "" }] as View[],
    outputs: [
      { id: "wall", name: "Stage wall", viewId: "v1" },
      { id: "lobby", name: "Lobby", viewId: "v1" },
    ] as Output[],
  };
  recompute();
});

async function storedOutputs(): Promise<Output[]> {
  const raw = await fs.readFile(path.join(TMP, "settings.json"), "utf8");
  return (JSON.parse(raw) as { outputs?: Output[] }).outputs ?? [];
}

const resolvedFor = (id: string) => stageController.getState().resolvedByOutput[id];

describe("a display's text size", () => {
  it("is null until one is kept, and then reaches the descriptor every display and preview reads", async () => {
    assert.equal(resolvedFor("wall")?.textSize, null, "an output nobody sized must read as unset, not as 100");
    await stageController.setOutputTextSize("wall", 150);
    assert.equal(resolvedFor("wall")?.textSize, 150, "the size never reached ResolvedOutput — a preview would draw 100%");
  });

  it("survives a restart, because it is on disk and not just in memory", async () => {
    await stageController.setOutputTextSize("wall", 150);
    const stored = await storedOutputs();
    assert.equal(stored.find((o) => o.id === "wall")?.textSize, 150, "the size was not persisted");
    ctl.state = { ...ctl.state, outputs: stored };
    recompute();
    assert.equal(resolvedFor("wall")?.textSize, 150, "the stored size did not come back");
  });

  it("is per display", async () => {
    await stageController.setOutputTextSize("wall", 150);
    assert.equal(resolvedFor("lobby")?.textSize, null);
    assert.equal((await storedOutputs()).find((o) => o.id === "lobby")?.textSize, undefined);
  });

  it("accepts both ends of the range and rounds a fraction", async () => {
    await stageController.setOutputTextSize("wall", 50);
    assert.equal(resolvedFor("wall")?.textSize, 50);
    await stageController.setOutputTextSize("wall", 300);
    assert.equal(resolvedFor("wall")?.textSize, 300);
    await stageController.setOutputTextSize("wall", 149.6);
    assert.equal(resolvedFor("wall")?.textSize, 150);
  });

  it("refuses a size outside the range, or not a number, and keeps what it had", async () => {
    await stageController.setOutputTextSize("wall", 150);
    for (const bad of [49, 301, 0, -10, Number.NaN, Infinity, "150", null, undefined, {}, [150], true]) {
      await assert.rejects(() => stageController.setOutputTextSize("wall", bad), /textSize must be a number from 50 to 300/, `accepted ${String(bad)}`);
    }
    assert.equal(resolvedFor("wall")?.textSize, 150);
  });

  it("refuses an output that does not exist rather than writing a ghost", async () => {
    await assert.rejects(() => stageController.setOutputTextSize("display-nowhere", 150), /not found/i);
  });

  it("writes and logs nothing when the size is already the one kept", async (t) => {
    await stageController.setOutputTextSize("wall", 150);
    const before = await fs.stat(path.join(TMP, "settings.json"));
    const lines = captureConsole(t, "log");
    await new Promise((r) => setTimeout(r, 20));
    await stageController.setOutputTextSize("wall", 150);
    assert.deepEqual(lines, [], "a display opened with the same ?text= on every boot logged a line each time");
    const after = await fs.stat(path.join(TMP, "settings.json"));
    assert.equal(after.mtimeMs, before.mtimeMs, "the settings file was rewritten for a size it already held");
  });

  it("does not disturb the other output flags", async () => {
    await stageController.setOutputLocked("wall", true);
    await stageController.setOutputTextSize("wall", 150);
    assert.deepEqual(
      { locked: resolvedFor("wall")?.locked, textSize: resolvedFor("wall")?.textSize },
      { locked: true, textSize: 150 },
    );
  });
});
