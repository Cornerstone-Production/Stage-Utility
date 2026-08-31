// Adding a screen while another screen is being edited keeps both.
//
// Every output mutator assigns `this.state` BEFORE awaiting its write, so the
// read and the assignment happen in one synchronous turn and nothing can
// interleave between them. addOutput did it after, and its await is a real
// atomicWrite plus rename — tens of milliseconds on an SD card. In that window
// commitOutputPatch read `this.state.outputs` without the new screen, assigned,
// and enqueued a patch that landed AFTER addOutput's write and replaced the
// whole array. settings.json lost the new display; memory lost the edit.
// Nothing errored, and the screen came back missing at the next restart.
//
// Driven through the real controller and asserted against settings.json,
// because the file is what a restart reads.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-out-race-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");

type Mutable = {
  state: { views: unknown[]; outputs: { id: string; name: string; viewId: string | null }[]; [k: string]: unknown };
  broadcast: () => void;
  recomputeResolved: () => void;
};
const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.state = {
  ...ctl.state,
  views: [],
  outputs: [{ id: "display-1", name: "Primary", viewId: null }],
};

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

async function outputsOnDisk(): Promise<{ id: string; name: string }[]> {
  const raw = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as {
    outputs?: { id: string; name: string }[];
  };
  return raw.outputs ?? [];
}

describe("a screen added mid-edit is not lost", () => {
  it("keeps BOTH the new display and the rename in settings.json", async () => {
    const adding = stageController.addOutput("Lobby");

    // One macrotask in: the allocation has run and the settings write is in
    // flight — exactly the window an operator's next click lands in.
    await new Promise((resolve) => setImmediate(resolve));

    await stageController.renameOutput("display-1", "Front of house");
    await adding;

    const disk = await outputsOnDisk();
    assert.deepEqual(
      disk.map((o) => o.id),
      ["display-1", "display-2"],
      "the display added during the rename is missing from settings.json — it vanishes at the next restart",
    );
    assert.equal(
      disk.find((o) => o.id === "display-1")?.name,
      "Front of house",
      "the rename was clobbered",
    );
    assert.deepEqual(
      ctl.state.outputs.map((o) => `${o.id}:${o.name}`),
      disk.map((o) => `${o.id}:${o.name}`),
      "memory and disk disagree about the screens",
    );
  });
});
