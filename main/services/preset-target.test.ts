// Which view does a preset actually land on?
//
// Output ids and view ids share one namespace and can collide. A real install had
// an output `display-2` routed to view `view-2`, AND a separate Mic Slots view
// also called `display-2`. Resolving outputs first meant the Views page asking for
// view `display-2` silently got `view-2`: nine slots written to the wrong view,
// with a success toast, nineteen times before anyone caught it.
//
// These drive the controller through its own state rather than a mock, so the
// resolution order is tested where it actually lives.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Output, Slot, View } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-preset-target-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");

type Ctl = {
  state: {
    views: View[];
    outputs: Output[];
    serviceTypeId: string | null;
    slotsByView: Record<string, Slot[]>;
  };
};
const ctl = () => stageController as unknown as Ctl;

const slot = (i: number): Slot =>
  ({ id: `s${i}`, channel: `0${i}`, order: i, link: { kind: "manual", name: `Ch ${i}` } }) as unknown as Slot;

/** The real collision: output display-2 -> view-2, plus a VIEW called display-2. */
function seedCollision(): void {
  ctl().state.views = [
    { id: "display-2", name: "Right Display", kind: "slots" },
    { id: "view-2", name: "Right Display - Stage Layout", kind: "custom" },
  ] as View[];
  ctl().state.outputs = [{ id: "display-2", name: "Right Display", viewId: "view-2" }] as Output[];
  ctl().state.serviceTypeId = "TYPE_B";
}

beforeEach(seedCollision);

describe("preset target resolution", () => {
  it("applies to the VIEW when an output shares its id", async () => {
    // importPreset APPENDS, so the one just added is last: presets persist across
    // these tests, which share one data dir.
    const presets = await stageController.importPreset("Default (Right)", [slot(1), slot(2), slot(3)]);
    const { viewId } = await stageController.applyPreset("display-2", presets.at(-1)!.id);
    assert.equal(viewId, "display-2", "must write the view, not the output's target");
  });

  it("reports the view it wrote, so the caller cannot read the wrong one", async () => {
    const presets = await stageController.importPreset("P", [slot(1), slot(2)]);
    const { state, viewId } = await stageController.applyPreset("display-2", presets.at(-1)!.id);
    assert.equal(state.slotsByView?.[viewId]?.length, 2);
  });

  it("still resolves a pure output id through its routing", async () => {
    // The legacy shape has to keep working: an output whose id is NOT also a view.
    ctl().state.outputs = [
      { id: "display-9", name: "Spare", viewId: "display-2" },
    ] as Output[];
    const presets = await stageController.importPreset("P", [slot(1)]);
    const { viewId } = await stageController.applyPreset("display-9", presets.at(-1)!.id);
    assert.equal(viewId, "display-2");
  });

  it("refuses a view that has no slots of its own, rather than writing nowhere", async () => {
    // view-2 is custom: its slots live per layout object, so anything written
    // under the view id is unreadable. Silence here is what cost the operator an
    // evening — nine slots stored where nothing would ever look.
    const presets = await stageController.importPreset("P", [slot(1)]);
    await assert.rejects(
      () => stageController.applyPreset("view-2", presets.at(-1)!.id),
      /has no slots of its own/,
    );
  });

  it("writes the applied slots under the ACTIVE service type", async () => {
    // The cross-service-type case: an arrangement saved on one type recalled on
    // another must land on the one that is active now.
    const presets = await stageController.importPreset("P", [slot(1), slot(2), slot(3)]);
    ctl().state.serviceTypeId = "TYPE_OTHER";
    const { viewId } = await stageController.applyPreset("display-2", presets.at(-1)!.id);
    const raw = JSON.parse(await fs.readFile(path.join(TMP, "slots.json"), "utf8"));
    assert.equal(raw[viewId]?.["TYPE_OTHER"]?.length, 3);
  });
});
