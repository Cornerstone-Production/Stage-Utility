// Duplicating a view and its slot boards. A copy shows the SAME boards as its
// original — a second screen over the same charger is what a board is for — and
// `copyBoards` gives it boards of its own instead, each a duplicate of the one
// it showed (every service type, fresh slot ids), held in memory straight away
// so the copy draws them without a restart.
//
// Driven against the real controller and the real slots store in a temp data
// directory. Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-view-duplicate-slots-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { slotsStore } = await import("./slots-store.js");
import type { SlotBoardMeta } from "../types/stage.js";

type Held = {
  state: { views: View[]; serviceTypeId: string | null; [k: string]: unknown };
  rawSlotsByBoard: Map<string, Slot[]>;
  boards: Map<string, SlotBoardMeta>;
  broadcast: () => void;
  recomputeResolved: () => void;
};
const ctl = stageController as unknown as Held;
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};

const NOW = "2026-01-01T00:00:00.000Z";
const row = (label: string): Slot =>
  ({ id: `row-${label}`, channel: "1", order: 0, link: { kind: "static", label, color: "#2E6691" } }) as unknown as Slot;
const labels = (rows: Slot[] | undefined) => (rows ?? []).map((r) => (r.link as { label: string }).label);
const gridConfig = (v: View) => v.layout!.objects[0]!.config as { boardId?: string | null; source?: string };

let n = 0;
async function board(name: string, rows: string[]): Promise<string> {
  const id = `b-test-${++n}`;
  await slotsStore.createBoard(id, { name, columnWidthIn: null, createdAt: NOW });
  await slotsStore.setDefault(id, "st-1", rows.map(row));
  ctl.boards = await slotsStore.listBoards();
  return id;
}

function pad(id: string, config: Record<string, unknown>): View {
  return {
    id, name: id, kind: "custom", surface: "display", createdAt: NOW,
    layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects: [{ id: `${id}-grid`, x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", ...config } }] },
  } as unknown as View;
}

beforeEach(() => {
  ctl.rawSlotsByBoard.clear();
});

describe("duplicating a view", () => {
  it("points the copy at the same boards, and makes none", async () => {
    const mics = await board("Mic board", ["Pastor"]);
    const drums = await board("Drums", ["Drums"]);
    ctl.state = {
      ...ctl.state,
      serviceTypeId: "st-1",
      views: [
        { id: "mics", name: "Mic board", kind: "slots", surface: "display", createdAt: NOW, boardId: mics },
        pad("pad", { boardId: drums }),
      ] as unknown as View[],
    };
    const before = (await slotsStore.listBoards()).size;

    await stageController.duplicateView("mics", "Mic board 2");
    await stageController.duplicateView("pad", "Pad 2");

    const mics2 = ctl.state.views.find((v) => v.name === "Mic board 2")!;
    const pad2 = ctl.state.views.find((v) => v.name === "Pad 2")!;
    assert.equal(mics2.boardId, mics, "the copied screen shows a different board from its original");
    assert.notEqual(pad2.layout!.objects[0]!.id, "pad-grid", "the copy shares the widget's object id with its source");
    assert.equal(gridConfig(pad2).boardId, drums, "the copied widget shows a different board from its original");
    assert.equal((await slotsStore.listBoards()).size, before, "a plain duplicate made boards");
  });

  it("with copyBoards, gives the copy duplicates of its boards, held in memory under their new ids", async () => {
    const mics = await board("Wall", ["Pastor"]);
    const drums = await board("Kit", ["Drums"]);
    ctl.state = {
      ...ctl.state,
      serviceTypeId: "st-1",
      views: [
        { id: "wall", name: "Wall", kind: "slots", surface: "display", createdAt: NOW, boardId: mics },
        pad("kit", { boardId: drums }),
      ] as unknown as View[],
    };

    await stageController.duplicateView("wall", "Wall 2", { copyBoards: true });
    await stageController.duplicateView("kit", "Kit 2", { copyBoards: true });

    const wall2 = ctl.state.views.find((v) => v.name === "Wall 2")!;
    const kit2 = ctl.state.views.find((v) => v.name === "Kit 2")!;
    const wallBoard = wall2.boardId!;
    const kitBoard = gridConfig(kit2).boardId!;
    assert.notEqual(wallBoard, mics);
    assert.notEqual(kitBoard, drums);
    const boards = await slotsStore.listBoards();
    assert.equal(boards.get(wallBoard)?.name, "Wall copy");
    assert.equal(boards.get(kitBoard)?.name, "Kit copy");
    assert.deepEqual(labels(await slotsStore.getDefault(wallBoard, "st-1")), ["Pastor"], "the screen's board was not copied");
    assert.deepEqual(labels(await slotsStore.getDefault(kitBoard, "st-1")), ["Drums"], "the widget's board was not copied");
    assert.notEqual((await slotsStore.getDefault(wallBoard, "st-1"))[0]?.id, "row-Pastor", "the copy shares slot ids with its source");
    assert.deepEqual(labels(ctl.rawSlotsByBoard.get(wallBoard)), ["Pastor"], "the copy's screen board is not held in memory");
    assert.deepEqual(labels(ctl.rawSlotsByBoard.get(kitBoard)), ["Drums"], "the copy's widget board is not held in memory");
  });

  it("points a copied widget from before boards at its original's board, not at its own new object id", async () => {
    // An install that has not migrated (a boot whose migration could not be
    // saved): an inline grid's board is its OWN object id, which the clone changes.
    await slotsStore.setDefault("old-grid", "st-1", [row("Bass")]);
    ctl.state = {
      ...ctl.state,
      serviceTypeId: "st-1",
      views: [
        {
          id: "old", name: "Old", kind: "custom", surface: "display", createdAt: NOW,
          layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects: [{ id: "old-grid", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", source: "inline" } }] },
        },
      ] as unknown as View[],
    };

    await stageController.duplicateView("old", "Old 2");

    const old2 = ctl.state.views.find((v) => v.name === "Old 2")!;
    assert.equal(gridConfig(old2).boardId, "old-grid", "the copied widget lost its slots");
    assert.equal(gridConfig(old2).source, undefined, "the shape from before boards was stored on the copy");
    assert.deepEqual(labels(ctl.rawSlotsByBoard.get("old-grid")), ["Bass"]);
  });
});
