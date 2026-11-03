// boards:changed, driven through every route that writes the slot boards, against
// the real controller and stores in a temp data directory.
//
// What is under test: a Mic slots page in another browser hears about EVERY
// write, by board, whichever path made it. The frame comes from the store's
// after-save hook, so the guard is the exact list below of the paths that were
// heard: a write path that bypassed the store would drop out of it.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-boards-changed-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { boardRoutes } = await import("./board-routes.js");
const { viewRoutes } = await import("./view-routes.js");
const { presetRoutes } = await import("./preset-routes.js");
const { serviceCueRoutes } = await import("./servicecue-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { slotsStore } = await import("../slots-store.js");
const { presetsStore } = await import("../presets-store.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { boardsChangedState } = await import("../boards-changed.js");
const { BOARDS_CHANGED_CHANNEL } = await import("../../types/boards-changed.js");
import type { BoardsChanged } from "../../types/boards-changed.js";
import type { SlotBoardMeta, StageState, View } from "../../types/stage.js";

const TYPE = "st-c";
const PLAN = "plan-c";
const NOW = "2026-10-29T00:00:00.000Z";

type Mutable = {
  state: StageState;
  boards: Map<string, SlotBoardMeta>;
  broadcast: () => void;
  loadAllViewRawSlots: (serviceTypeId: string | null, planId: string | null) => Promise<void>;
};
const ctl = stageController as unknown as Mutable;

const slot = (id: string, position = "Lead Vocal Person"): Slot =>
  ({ id, channel: "01", order: 0, link: { kind: "pco", matchBy: "position", positions: [{ name: position }] }, deviceBinding: null }) as unknown as Slot;

const frames: BoardsChanged[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === BOARDS_CHANGED_CHANNEL) frames.push(payload as BoardsChanged);
});

async function call(route: Parameters<typeof callRoute>[0], p: string, method = "GET", body?: unknown) {
  const r = await callRoute(route, p, { method, ...(body !== undefined ? { body } : {}) });
  assert.ok(r.status !== null && r.status < 300, `${method} ${p} answered ${r.status}: ${r.body}`);
  return r;
}

/** Board LEFT on two screens and a widget, RIGHT on a third; both with a default,
 *  LEFT with an override for PLAN. */
async function seed(): Promise<void> {
  for (const id of (await slotsStore.listBoards()).keys()) await slotsStore.deleteBoard(id);
  await slotsStore.createBoard("b-left", { name: "Left", columnWidthIn: null, createdAt: NOW });
  await slotsStore.createBoard("b-right", { name: "Right", columnWidthIn: null, createdAt: NOW });
  await slotsStore.setDefault("b-left", TYPE, [slot("l1")]);
  await slotsStore.setDefault("b-right", TYPE, [slot("r1")]);
  await slotsStore.setOverride("b-left", PLAN, TYPE, [slot("p1")], "2026-10-25T14:00:00Z");
  ctl.boards = await slotsStore.listBoards();
  ctl.state = {
    ...ctl.state,
    serviceTypeId: TYPE,
    planId: PLAN,
    views: [
      { id: "wall-1", name: "Left Display", kind: "slots", createdAt: "", boardId: "b-left" },
      { id: "wall-3", name: "Right Display", kind: "slots", createdAt: "", boardId: "b-right" },
      {
        id: "pad", name: "Stage Layout", kind: "custom", createdAt: "", layoutRev: 0,
        layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects: [{ id: "g-1", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", boardId: "b-left" } }] },
      },
    ] as unknown as View[],
    outputs: [{ id: "display-1", name: "Left", viewId: "wall-1" }],
  };
  await ctl.loadAllViewRawSlots(TYPE, PLAN);
  await presetsStore.save([{ id: "p-band", name: "Band", slots: [slot("a"), slot("b")], createdAt: NOW }]);
}

before(() => {
  ctl.broadcast = () => {};
});
beforeEach(seed);
after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const DEFAULT = `default:${TYPE}`;
const OVERRIDE = `plan:${PLAN}`;
const DEF = { kind: "default", serviceTypeId: TYPE };

/**
 * Every path that writes the slot boards, what it should be heard as: the board
 * (or "new" for one it makes), whether its name/width/existence changed, and
 * which of its layouts.
 */
const PATHS: { name: string; run: () => Promise<unknown>; board: string; meta: boolean; targets: string[] }[] = [
  { name: "DELETE /api/boards/:id", run: () => call(boardRoutes, "/api/boards/b-right", "DELETE", { replacement: null }), board: "b-right", meta: true, targets: [DEFAULT] },
  { name: "DELETE /api/boards/:id/override/:planId", run: () => call(boardRoutes, `/api/boards/b-left/override/${PLAN}`, "DELETE"), board: "b-left", meta: false, targets: [OVERRIDE] },
  { name: "DELETE /api/views/:id/slots/override/:planId", run: () => call(viewRoutes, `/api/views/wall-1/slots/override/${PLAN}`, "DELETE"), board: "b-left", meta: false, targets: [OVERRIDE] },
  { name: "PATCH /api/boards/:id column width", run: () => call(boardRoutes, "/api/boards/b-left", "PATCH", { columnWidthIn: 4 }), board: "b-left", meta: true, targets: [] },
  { name: "PATCH /api/boards/:id name", run: () => call(boardRoutes, "/api/boards/b-left", "PATCH", { name: "Left again" }), board: "b-left", meta: true, targets: [] },
  { name: "POST /api/boards", run: () => call(boardRoutes, "/api/boards", "POST", { name: "Choir" }), board: "new", meta: true, targets: [] },
  { name: "POST /api/boards from a saved layout", run: () => call(boardRoutes, "/api/boards", "POST", { name: "Band board", from: { presetId: "p-band" } }), board: "new", meta: true, targets: [DEFAULT] },
  { name: "POST /api/boards/:id/copy-from", run: () => call(boardRoutes, "/api/boards/b-left/copy-from", "POST", { fromBoardId: "b-right", target: DEF }), board: "b-left", meta: false, targets: [DEFAULT] },
  { name: "POST /api/boards/:id/duplicate", run: () => call(boardRoutes, "/api/boards/b-right/duplicate", "POST", {}), board: "new", meta: true, targets: [DEFAULT] },
  { name: "POST /api/boards/:id/promote", run: () => call(boardRoutes, "/api/boards/b-left/promote", "POST", { planId: PLAN }), board: "b-left", meta: false, targets: [DEFAULT, OVERRIDE] },
  { name: "POST /api/boards/slots", run: () => call(boardRoutes, "/api/boards/slots", "POST", { boards: [{ boardId: "b-right", slots: [slot("r2")], target: DEF }] }), board: "b-right", meta: false, targets: [DEFAULT] },
  { name: "POST /api/layout-objects/:id/slots", run: () => call(viewRoutes, "/api/layout-objects/g-1/slots", "POST", { slots: [slot("g")], target: DEF }), board: "b-left", meta: false, targets: [DEFAULT] },
  { name: "POST /api/presets/:id/apply", run: () => call(presetRoutes, "/api/presets/p-band/apply", "POST", { viewId: "wall-3", target: DEF }), board: "b-right", meta: false, targets: [DEFAULT] },
  { name: "POST /api/slots", run: () => call(serviceCueRoutes, "/api/slots", "POST", { displayId: "display-1", slots: [slot("s")] }), board: "b-left", meta: false, targets: [OVERRIDE] },
  { name: "POST /api/views (a slots screen)", run: () => call(viewRoutes, "/api/views", "POST", { name: "New wall", kind: "slots" }), board: "new", meta: true, targets: [] },
  {
    name: "POST /api/views/import",
    run: async () => {
      const bundle = (await call(viewRoutes, "/api/views/wall-3/export")).json;
      frames.length = 0;
      return call(viewRoutes, "/api/views/import", "POST", bundle);
    },
    board: "new",
    meta: true,
    targets: [DEFAULT],
  },
  { name: "POST /api/views/:id/copy-slots", run: () => call(viewRoutes, "/api/views/wall-3/copy-slots", "POST", { fromViewId: "wall-1", target: DEF }), board: "b-right", meta: false, targets: [DEFAULT] },
  { name: "POST /api/views/:id/slots", run: () => call(viewRoutes, "/api/views/wall-3/slots", "POST", { slots: [slot("v")], target: DEF }), board: "b-right", meta: false, targets: [DEFAULT] },
  { name: "POST /api/views/:id/slots/promote", run: () => call(viewRoutes, "/api/views/wall-1/slots/promote", "POST", { planId: PLAN }), board: "b-left", meta: false, targets: [DEFAULT, OVERRIDE] },
  {
    name: "the daily prune of old plan layouts",
    run: async () => {
      await slotsStore.setOverride("b-right", "plan-old", TYPE, [slot("o")], "2020-01-05T14:00:00Z");
      frames.length = 0;
      return stageController.pruneSlotOverrides();
    },
    board: "b-right",
    meta: false,
    targets: ["plan:plan-old"],
  },
];

describe("boards:changed", () => {
  it("is heard, naming the board and what changed on it, from every path that writes the boards", async () => {
    const heard: string[] = [];
    const wrong: string[] = [];
    for (const p of PATHS) {
      await seed();
      const known = new Set(ctl.boards.keys());
      frames.length = 0;
      await p.run();
      const named = frames.flatMap((f) => f.boards).filter((b) => (p.board === "new" ? !known.has(b.id) : b.id === p.board));
      if (named.length === 0) continue;
      heard.push(p.name);
      const got = { meta: named.some((b) => b.meta), targets: [...new Set(named.flatMap((b) => b.targets))].sort() };
      const want = { meta: p.meta, targets: p.targets };
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${p.name}: ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
    }
    assert.deepEqual(heard, [
      "DELETE /api/boards/:id",
      "DELETE /api/boards/:id/override/:planId",
      "DELETE /api/views/:id/slots/override/:planId",
      "PATCH /api/boards/:id column width",
      "PATCH /api/boards/:id name",
      "POST /api/boards",
      "POST /api/boards from a saved layout",
      "POST /api/boards/:id/copy-from",
      "POST /api/boards/:id/duplicate",
      "POST /api/boards/:id/promote",
      "POST /api/boards/slots",
      "POST /api/layout-objects/:id/slots",
      "POST /api/presets/:id/apply",
      "POST /api/slots",
      "POST /api/views (a slots screen)",
      "POST /api/views/import",
      "POST /api/views/:id/copy-slots",
      "POST /api/views/:id/slots",
      "POST /api/views/:id/slots/promote",
      "the daily prune of old plan layouts",
    ]);
    assert.deepEqual(wrong, []);
  });

  it("numbers every write, one after the last, and the connect burst re-sends the last", async () => {
    frames.length = 0;
    await call(boardRoutes, "/api/boards/b-left", "PATCH", { name: "One" });
    await call(boardRoutes, "/api/boards/b-left", "PATCH", { name: "Two" });
    assert.equal(frames.length, 2);
    assert.equal(frames[1]!.seq, frames[0]!.seq + 1);
    assert.equal(frames[1]!.epoch, frames[0]!.epoch);
    assert.deepEqual(boardsChangedState(), frames[1]);
  });

  it("names a board other boards' writes did not touch, and carries no slot contents", async () => {
    frames.length = 0;
    await call(boardRoutes, "/api/boards/slots", "POST", { boards: [{ boardId: "b-right", slots: [slot("r9", "Someone Private")], target: DEF }] });
    assert.deepEqual(frames.map((f) => f.boards), [[{ id: "b-right", meta: false, targets: [DEFAULT] }]]);
    const wire = JSON.stringify(frames);
    assert.equal(wire.includes("Someone Private") || wire.includes("r9"), false, "a slot's contents went out on boards:changed");
  });
});
