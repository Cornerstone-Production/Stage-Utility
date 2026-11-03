// Board writes that must refuse before they write, and board pointers that
// only a slots screen has. Driven through the real handlers against the real
// controller and stores in a temp data directory, like board-routes.test.ts.
// No Planning Center: the service type and plan are poked onto the state.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-board-integrity-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { boardRoutes } = await import("./board-routes.js");
const { viewRoutes } = await import("./view-routes.js");
const { presetRoutes } = await import("./preset-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { slotsStore } = await import("../slots-store.js");
const { presetsStore } = await import("../presets-store.js");
import type { Slot, SlotBoardMeta, StageState, View } from "../../types/stage.js";

const TYPE = "st-i";
const PLAN = "plan-i";

type Mutable = {
  state: StageState;
  boards: Map<string, SlotBoardMeta>;
  broadcast: () => void;
  loadAllViewRawSlots: (serviceTypeId: string | null, planId: string | null) => Promise<void>;
};
const ctl = stageController as unknown as Mutable;

const slot = (id: string): Slot =>
  ({ id, channel: "01", order: 0, link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] }, deviceBinding: null }) as unknown as Slot;
const ids = (rows: Slot[] | undefined) => (rows ?? []).map((r) => r.id);
const NOW = "2026-11-02T00:00:00.000Z";
const grid = (id: string, boardId: string) => ({ id, x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", boardId } });
const layoutOf = (objects: unknown[]) => ({ version: 1, canvas: { width: 1920, height: 1080 }, objects });

async function call(route: Parameters<typeof callRoute>[0], p: string, method = "GET", body?: unknown) {
  return callRoute(route, p, { method, ...(body !== undefined ? { body } : {}) });
}

/**
 * A slots screen on LEFT; "pad", a custom view whose one widget shows LEFT and
 * which still carries a board pointer at RIGHT from an earlier life as a slots
 * screen; "blank", a custom view with no widget at all.
 */
async function seed(): Promise<void> {
  for (const id of (await slotsStore.listBoards()).keys()) await slotsStore.deleteBoard(id);
  await slotsStore.createBoard("b-left", { name: "Left", columnWidthIn: null, createdAt: NOW });
  await slotsStore.createBoard("b-right", { name: "Right", columnWidthIn: null, createdAt: NOW });
  await slotsStore.setDefault("b-left", TYPE, [slot("l1"), slot("l2")]);
  await slotsStore.setDefault("b-right", TYPE, [slot("r1")]);
  await presetsStore.save([{ id: "p-1", name: "Opening", slots: [slot("p")], createdAt: NOW, boardId: "b-left" }]);
  ctl.boards = await slotsStore.listBoards();
  ctl.state = {
    ...ctl.state,
    serviceTypeId: TYPE,
    planId: PLAN,
    views: [
      { id: "wall-1", name: "Left Display", kind: "slots", createdAt: "", boardId: "b-left" },
      { id: "pad", name: "Stage Layout", kind: "custom", createdAt: "", layoutRev: 0, boardId: "b-right", layout: layoutOf([grid("g-1", "b-left")]) },
      { id: "blank", name: "Empty Layout", kind: "custom", createdAt: "", layoutRev: 0, layout: layoutOf([]) },
    ] as unknown as View[],
    outputs: [{ id: "display-1", name: "Left", viewId: "wall-1" }],
  };
  await ctl.loadAllViewRawSlots(TYPE, PLAN);
}

before(() => {
  ctl.broadcast = () => {};
});
beforeEach(seed);
after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("a custom view's leftover board pointer", () => {
  it("is not a board the view's slot routes write to", async () => {
    const r = await call(viewRoutes, "/api/views/pad/slots", "POST", { slots: [slot("x")] });
    assert.equal(r.status, 404, JSON.stringify(r.json));
    assert.deepEqual(ids(await slotsStore.getDefault("b-right", TYPE)), ["r1"], "a write landed on a board the custom view does not show");
  });
});

describe("overwriting a saved layout from a view", () => {
  const preset = async () => (await presetsStore.load()).find((p) => p.id === "p-1")!;

  it("from a custom view takes the board its one widget shows", async () => {
    const r = await call(presetRoutes, "/api/presets/p-1", "PATCH", { overwriteFromDisplayId: "pad" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await preset()).slots.length, 2, "the saved layout was emptied, not overwritten with the widget's board");
  });

  it("from a view with no slots is refused, and the saved layout is kept", async () => {
    const r = await call(presetRoutes, "/api/presets/p-1", "PATCH", { overwriteFromDisplayId: "blank" });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.deepEqual(ids((await preset()).slots), ["p"]);
  });
});

describe("PATCH /api/presets/:id refuses before it renames", () => {
  const name = async () => (await presetsStore.load()).find((p) => p.id === "p-1")!.name;

  it("a board id that is not a string", async () => {
    const r = await call(presetRoutes, "/api/presets/p-1", "PATCH", { name: "Renamed", slots: [slot("w")], boardId: 7 });
    assert.equal(r.status, 400);
    assert.equal(await name(), "Opening", "the rename landed beside a refused body");
  });

  it("a board that does not exist", async () => {
    const r = await call(presetRoutes, "/api/presets/p-1", "PATCH", { name: "Renamed", slots: [slot("w")], boardId: "b-gone" });
    assert.equal(r.status, 404);
    assert.equal(await name(), "Opening", "the rename landed beside a refused body");
  });

  it("an overwrite from a view with no slots", async () => {
    const r = await call(presetRoutes, "/api/presets/p-1", "PATCH", { name: "Renamed", overwriteFromDisplayId: "blank" });
    assert.equal(r.status, 400);
    assert.equal(await name(), "Opening", "the rename landed beside a refused body");
  });

  it("and still renames and overwrites together when nothing is refused", async () => {
    const r = await call(presetRoutes, "/api/presets/p-1", "PATCH", { name: "Renamed", slots: [slot("w")], boardId: "b-right" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const saved = (await presetsStore.load()).find((p) => p.id === "p-1")!;
    assert.equal(saved.name, "Renamed");
    assert.equal(saved.boardId, "b-right");
    assert.equal(saved.slots.length, 1);
  });
});

describe("POST /api/boards holding a saved layout checks where it lands", () => {
  const boardCount = async () => (await slotsStore.listBoards()).size;

  it("refuses a service type key that could not be stored, writing no board", async () => {
    const before = await boardCount();
    const r = await call(boardRoutes, "/api/boards", "POST", {
      name: "Bad", from: { presetId: "p-1" }, target: { kind: "default", serviceTypeId: "__proto__" },
    }).catch((err: unknown) => ({ status: 500, json: String(err) }));
    assert.notEqual(r.status, 201, JSON.stringify(r.json));
    assert.equal(await boardCount(), before, "a board was stored under a key every later backup restore refuses");
  });

  it("refuses a plan override naming a service type the plan is not in, writing no board", async () => {
    const before = await boardCount();
    const r = await call(boardRoutes, "/api/boards", "POST", {
      name: "Wrong type", from: { presetId: "p-1" }, target: { kind: "plan", planId: PLAN, serviceTypeId: "st-other" },
    });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(await boardCount(), before, "a board was stored with an override no screen can show");
  });
});

describe("slotsStore.createBoard", () => {
  it("refuses a layout under a key that could not be stored, and writes nothing", async () => {
    const before = [...(await slotsStore.listBoards()).keys()];
    await assert.rejects(
      slotsStore.createBoard("b-new", { name: "New", columnWidthIn: null, createdAt: NOW }, { defaults: new Map([["__proto__", [slot("x")]]]) }),
      /serviceTypeId/,
    );
    await assert.rejects(
      slotsStore.createBoard("b-new", { name: "New", columnWidthIn: null, createdAt: NOW }, {
        overrides: new Map([["constructor", { serviceTypeId: TYPE, sortDate: null, slots: [slot("x")] }]]),
      }),
      /planId/,
    );
    await assert.rejects(
      slotsStore.createBoard("b-new", { name: "New", columnWidthIn: null, createdAt: NOW }, {
        overrides: new Map([[PLAN, { serviceTypeId: "__proto__", sortDate: null, slots: [slot("x")] }]]),
      }),
      /serviceTypeId/,
    );
    assert.deepEqual([...(await slotsStore.listBoards()).keys()], before);
  });
});
