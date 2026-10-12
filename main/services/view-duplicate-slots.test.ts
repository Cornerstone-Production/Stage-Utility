// Duplicating a view carries its slot boards: a slots view's own board, and the
// board of each inline mic-slots grid in a custom layout (under the copy's NEW
// object ids), for every service type, and the controller holds the copy's boards
// in memory straight away so the copy draws them without a restart. Driven
// against the real controller and the real slots store in a temp data directory.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-view-duplicate-slots-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { slotsStore } = await import("./slots-store.js");

type Held = {
  state: { views: View[]; serviceTypeId: string | null; [k: string]: unknown };
  rawSlotsByView: Map<string, Slot[]>;
  rawSlotsByObject: Map<string, Slot[]>;
  broadcast: () => void;
  recomputeResolved: () => void;
};
const ctl = stageController as unknown as Held;
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};

const NOW = "2026-01-01T00:00:00.000Z";
const row = (label: string): Slot =>
  ({ id: `row-${label}`, channel: "1", order: 0, link: { kind: "static", label, color: "#2E6691" } }) as unknown as Slot;

describe("duplicating a view", () => {
  it("copies a slots view's board and an inline grid's board, and holds both in memory under the copy's ids", async () => {
    ctl.state = {
      ...ctl.state,
      serviceTypeId: "st-1",
      views: [
        { id: "mics", name: "Mic board", kind: "slots", surface: "display", createdAt: NOW },
        {
          id: "pad", name: "Pad", kind: "custom", surface: "display", createdAt: NOW,
          layout: {
            version: 1,
            canvas: { width: 1920, height: 1080 },
            objects: [{ id: "grid-1", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", source: "inline" } }],
          },
        },
      ] as unknown as View[],
    };
    await slotsStore.setDefault("mics", "st-1", [row("Pastor")]);
    await slotsStore.setDefault("grid-1", "st-1", [row("Drums")]);

    await stageController.duplicateView("mics", "Mic board 2");
    await stageController.duplicateView("pad", "Pad 2");

    const mics2 = ctl.state.views.find((v) => v.name === "Mic board 2")!;
    const pad2 = ctl.state.views.find((v) => v.name === "Pad 2")!;
    const grid2 = pad2.layout!.objects[0].id;
    assert.notEqual(grid2, "grid-1", "the copy shares the grid's object id with its source");
    const labels = (rows: Slot[] | undefined) => (rows ?? []).map((r) => (r.link as { label: string }).label);
    assert.deepEqual(labels(await slotsStore.getDefault(mics2.id, "st-1")), ["Pastor"], "the slots view's board was not copied");
    assert.deepEqual(labels(await slotsStore.getDefault(grid2, "st-1")), ["Drums"], "the inline grid's board was not copied under the new id");
    assert.deepEqual(labels(ctl.rawSlotsByView.get(mics2.id)), ["Pastor"], "the copy's board is not held in memory");
    assert.deepEqual(labels(ctl.rawSlotsByObject.get(grid2)), ["Drums"], "the copy's inline board is not held in memory");
  });
});
