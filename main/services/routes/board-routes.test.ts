// The slot board routes, and the older per-screen routes as aliases onto them,
// driven through the real handlers against the real controller and stores in a
// temp data directory. No Planning Center: the service type and plan are poked
// onto the controller's state.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-board-routes-"));
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
import type { SlotBoardDTO, SlotBoardMeta, StageState, View } from "../../types/stage.js";

const TYPE = "st-b";
const PLAN = "plan-b";

type Mutable = {
  state: StageState;
  boards: Map<string, SlotBoardMeta>;
  broadcast: () => void;
  loadAllViewRawSlots: (serviceTypeId: string | null, planId: string | null) => Promise<void>;
};
const ctl = stageController as unknown as Mutable;

const slot = (id: string, position = "Vocals"): Slot =>
  ({ id, channel: "01", order: 0, link: { kind: "pco", matchBy: "position", positions: [{ name: position }] }, deviceBinding: null }) as unknown as Slot;
const ids = (rows: Slot[] | undefined) => (rows ?? []).map((r) => r.id);
const NOW = "2026-10-29T00:00:00.000Z";

async function call(route: Parameters<typeof callRoute>[0], p: string, method = "GET", body?: unknown) {
  return callRoute(route, p, { method, ...(body !== undefined ? { body } : {}) });
}

/** Two screens sharing board LEFT, a third on RIGHT, and a widget on LEFT. */
async function seed(): Promise<void> {
  for (const id of (await slotsStore.listBoards()).keys()) await slotsStore.deleteBoard(id);
  await slotsStore.createBoard("b-left", { name: "Left", columnWidthIn: 3.49, createdAt: NOW });
  await slotsStore.createBoard("b-right", { name: "Right", columnWidthIn: null, createdAt: NOW });
  ctl.boards = await slotsStore.listBoards();
  ctl.state = {
    ...ctl.state,
    serviceTypeId: TYPE,
    planId: null,
    views: [
      { id: "wall-1", name: "Left Display", kind: "slots", createdAt: "", boardId: "b-left", slotsLayout: { displayWidthIn: 32.25 } },
      { id: "wall-2", name: "Left Confidence", kind: "slots", createdAt: "", boardId: "b-left" },
      { id: "wall-3", name: "Right Display", kind: "slots", createdAt: "", boardId: "b-right" },
      {
        id: "pad", name: "Stage Layout", kind: "custom", createdAt: "", layoutRev: 0,
        layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects: [{ id: "g-1", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", boardId: "b-left", displayWidthIn: 20 } }] },
      },
    ] as unknown as View[],
    outputs: [{ id: "display-1", name: "Left", viewId: "wall-1" }],
  };
  await ctl.loadAllViewRawSlots(TYPE, null);
}

before(() => {
  ctl.broadcast = () => {};
});
beforeEach(seed);
after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("GET /api/boards", () => {
  it("lists every board by name with where it is shown", async () => {
    const r = await call(boardRoutes, "/api/boards");
    assert.equal(r.status, 200);
    const list = r.json as SlotBoardDTO[];
    assert.deepEqual(list.map((b) => [b.id, b.name, b.columnWidthIn]), [["b-left", "Left", 3.49], ["b-right", "Right", null]]);
    assert.deepEqual(list[0]!.shownOn, [
      { kind: "view", id: "wall-1", name: "Left Display", viewId: "wall-1" },
      { kind: "view", id: "wall-2", name: "Left Confidence", viewId: "wall-2" },
      { kind: "object", id: "g-1", name: "Stage Layout", viewId: "pad" },
    ]);
  });
});

describe("the screens showing a board", () => {
  it("all change with one write to it, and each draws its own alignment", async () => {
    await call(viewRoutes, "/api/views/wall-1/slots", "POST", { slots: [slot("s1")] });
    const s = ctl.state;
    assert.deepEqual(ids(s.slotsByView["wall-1"]), ["s1"]);
    assert.deepEqual(ids(s.slotsByView["wall-2"]), ["s1"], "a second screen on the same board did not change");
    assert.deepEqual(ids(s.slotsByLayoutObject["g-1"]), ["s1"], "a widget on the same board did not change");
    assert.deepEqual(ids(s.slotsByView["wall-3"]), [], "a screen on another board changed");
    assert.deepEqual(s.slotsLayoutByView["wall-1"], { displayWidthIn: 32.25, columnWidthIn: 3.49 });
    assert.equal(s.slotsLayoutByView["wall-2"], null, "a screen with no display width drew aligned");
    assert.deepEqual(s.slotsLayoutByLayoutObject["g-1"], { displayWidthIn: 20, columnWidthIn: 3.49 });
  });
});

describe("POST /api/boards/slots — save all", () => {
  it("writes every board in one go and the screens follow", async () => {
    const r = await call(boardRoutes, "/api/boards/slots", "POST", {
      boards: [
        { boardId: "b-left", slots: [slot("l1")], target: { kind: "default", serviceTypeId: TYPE } },
        { boardId: "b-right", slots: [slot("r1"), slot("r2")], target: { kind: "default", serviceTypeId: TYPE } },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(ids(ctl.state.slotsByView["wall-2"]), ["l1"]);
    assert.deepEqual(ids(ctl.state.slotsByView["wall-3"]), ["r1", "r2"]);
    assert.deepEqual(ids(await slotsStore.getDefault("b-right", TYPE)), ["r1", "r2"]);
  });

  it("writes NOTHING when one entry is bad, and the error names the board", async () => {
    await slotsStore.setDefault("b-left", TYPE, [slot("before")]);
    const r = await call(boardRoutes, "/api/boards/slots", "POST", {
      boards: [
        { boardId: "b-left", slots: [slot("after")], target: { kind: "default", serviceTypeId: TYPE } },
        { boardId: "b-right", slots: [slot("x")], target: { kind: "plan", serviceTypeId: TYPE } },
      ],
    });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /^Board "Right": body\.target must be/);
    assert.deepEqual(ids(await slotsStore.getDefault("b-left", TYPE)), ["before"], "the good entry landed though the save was refused");
  });

  it("writes nothing when a board does not exist, naming it", async () => {
    await slotsStore.setDefault("b-left", TYPE, [slot("before")]);
    const r = await call(boardRoutes, "/api/boards/slots", "POST", {
      boards: [
        { boardId: "b-left", slots: [slot("after")] },
        { boardId: "b-gone", slots: [] },
      ],
    });
    assert.equal(r.status, 404);
    assert.match((r.json as { error: string }).error, /^Board "b-gone": There is no board b-gone/);
    assert.deepEqual(ids(await slotsStore.getDefault("b-left", TYPE)), ["before"]);
  });

  it("refuses one board named twice for one target", async () => {
    const r = await call(boardRoutes, "/api/boards/slots", "POST", {
      boards: [{ boardId: "b-left", slots: [] }, { boardId: "b-left", slots: [slot("x")] }],
    });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /^Board "Left": It is in this save twice/);
  });
});

describe("creating, changing and copying boards", () => {
  it("creates a blank board, and a copy of another with fresh slot ids", async () => {
    await slotsStore.setDefault("b-left", TYPE, [slot("orig")]);
    const blank = await call(boardRoutes, "/api/boards", "POST", { name: "  Choir  " });
    assert.equal(blank.status, 201);
    const blankId = (blank.json as { id: string }).id;
    assert.match(blankId, /^b-/);
    assert.equal(ctl.boards.get(blankId)?.name, "Choir");

    const copy = await call(boardRoutes, "/api/boards", "POST", { name: "Left again", from: { boardId: "b-left" } });
    const copyId = (copy.json as { id: string }).id;
    const rows = await slotsStore.getDefault(copyId, TYPE);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.id, "orig", "the copy shares slot ids with its source");
    assert.equal(ctl.boards.get(copyId)?.columnWidthIn, 3.49);
  });

  it("creates a board holding a saved layout, under the current type's default", async () => {
    await presetsStore.save([{ id: "p-band", name: "Band", slots: [slot("a"), slot("b")], createdAt: NOW }]);
    const r = await call(boardRoutes, "/api/boards", "POST", { name: "Band board", from: { presetId: "p-band" } });
    assert.equal(r.status, 201);
    assert.equal((await slotsStore.getDefault((r.json as { id: string }).id, TYPE)).length, 2);
  });

  it("refuses a board with no name", async () => {
    const r = await call(boardRoutes, "/api/boards", "POST", { name: " " });
    assert.equal(r.status, 400);
  });

  it("renames a board and sets its column width, which every screen on it draws", async () => {
    const r = await call(boardRoutes, "/api/boards/b-left", "PATCH", { name: "Left chargers", columnWidthIn: 4 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(ctl.boards.get("b-left")?.name, "Left chargers");
    assert.deepEqual(ctl.state.slotsLayoutByView["wall-1"], { displayWidthIn: 32.25, columnWidthIn: 4 });
    const off = await call(boardRoutes, "/api/boards/b-left", "PATCH", { columnWidthIn: null });
    assert.equal(off.status, 200);
    assert.equal(ctl.state.slotsLayoutByView["wall-1"], null);
    assert.equal((await call(boardRoutes, "/api/boards/b-left", "PATCH", { columnWidthIn: -1 })).status, 400);
  });

  it("duplicates a board", async () => {
    await slotsStore.setDefault("b-right", TYPE, [slot("r")]);
    const r = await call(boardRoutes, "/api/boards/b-right/duplicate", "POST", {});
    assert.equal(r.status, 201);
    const id = (r.json as { id: string }).id;
    assert.equal(ctl.boards.get(id)?.name, "Right copy");
    assert.equal((await slotsStore.getDefault(id, TYPE)).length, 1);
  });

  it("copies another board's layout into one target", async () => {
    await slotsStore.setDefault("b-right", TYPE, [slot("r1"), slot("r2")]);
    const r = await call(boardRoutes, "/api/boards/b-left/copy-from", "POST", { fromBoardId: "b-right", target: { kind: "default", serviceTypeId: TYPE } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rows = await slotsStore.getDefault("b-left", TYPE);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.id, "r1");
    assert.deepEqual(ids(await slotsStore.getDefault("b-right", TYPE)), ["r1", "r2"], "the source changed");
  });
});

describe("DELETE /api/boards/:id", () => {
  it("points every screen and widget on it at the replacement, then deletes it", async () => {
    await slotsStore.setDefault("b-left", TYPE, [slot("gone")]);
    await slotsStore.setDefault("b-right", TYPE, [slot("r")]);
    // Written behind the controller's back, so read into memory as a boot would.
    await ctl.loadAllViewRawSlots(TYPE, null);
    const r = await call(boardRoutes, "/api/boards/b-left", "DELETE", { replacement: "b-right" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const views = ctl.state.views;
    assert.deepEqual(views.filter((v) => v.kind === "slots").map((v) => v.boardId), ["b-right", "b-right", "b-right"]);
    assert.equal((views.find((v) => v.id === "pad")!.layout!.objects[0]!.config as { boardId: string }).boardId, "b-right");
    assert.deepEqual(ids(ctl.state.slotsByView["wall-1"]), ["r"]);
    assert.equal((await slotsStore.listBoards()).has("b-left"), false);
    assert.deepEqual(await slotsStore.getDefault("b-left", TYPE), []);
  });

  it("with null leaves its screens showing nothing", async () => {
    const r = await call(boardRoutes, "/api/boards/b-left", "DELETE", { replacement: null });
    assert.equal(r.status, 200);
    assert.equal(ctl.state.views.find((v) => v.id === "wall-1")!.boardId, null);
    assert.deepEqual(ctl.state.slotsByView["wall-1"], []);
  });

  it("requires the replacement to be said, and to exist", async () => {
    assert.equal((await call(boardRoutes, "/api/boards/b-left", "DELETE", {})).status, 400);
    assert.equal((await call(boardRoutes, "/api/boards/b-left", "DELETE", { replacement: "b-nope" })).status, 404);
    assert.equal((await call(boardRoutes, "/api/boards/b-left", "DELETE", { replacement: "b-left" })).status, 400);
    assert.ok((await slotsStore.listBoards()).has("b-left"), "a refused delete removed the board");
  });
});

describe("deleting a screen", () => {
  it("leaves its board, still listed", async () => {
    await slotsStore.setDefault("b-right", TYPE, [slot("keep")]);
    const r = await call(viewRoutes, "/api/views/wall-3", "DELETE");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok((await slotsStore.listBoards()).has("b-right"), "the screen's board went with it");
    assert.deepEqual(ids(await slotsStore.getDefault("b-right", TYPE)), ["keep"]);
    const listed = (await call(boardRoutes, "/api/boards")).json as SlotBoardDTO[];
    assert.deepEqual(listed.find((b) => b.id === "b-right")?.shownOn, []);
  });
});

describe("one plan's layout on a board", () => {
  it("reads both targets, reverts and promotes", async () => {
    ctl.state = { ...ctl.state, planId: PLAN };
    await call(boardRoutes, "/api/boards/slots", "POST", { boards: [{ boardId: "b-right", slots: [slot("week")], target: { kind: "plan", planId: PLAN, serviceTypeId: TYPE } }] });
    const t = (await call(boardRoutes, `/api/boards/b-right/targets?serviceTypeId=${TYPE}&planId=${PLAN}`)).json as { boardId: string; scope: string; overrideSlots: Slot[] | null };
    assert.equal(t.scope, "board");
    assert.equal(t.boardId, "b-right");
    assert.deepEqual(ids(t.overrideSlots ?? []), ["week"]);
    assert.equal((await call(boardRoutes, `/api/boards/b-right/promote`, "POST", { planId: PLAN })).status, 200);
    assert.deepEqual(ids(await slotsStore.getDefault("b-right", TYPE)), ["week"]);
    assert.equal((await call(boardRoutes, `/api/boards/b-right/override/${PLAN}`, "DELETE")).status, 404, "a revert with nothing to revert succeeded");
  });
});

describe("GET /api/boards/check", () => {
  it("on a type's default (no week, no people) still lists the slots that accept no position", async () => {
    await slotsStore.setDefault("b-right", TYPE, [slot("ok"), { ...slot("bare"), link: { kind: "pco", matchBy: "position", positions: [] } } as unknown as Slot]);
    const r = await call(boardRoutes, `/api/boards/check?serviceTypeId=${TYPE}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, {
      serviceTypeId: TYPE,
      planId: null,
      roster: "none",
      unplaced: [],
      noPosition: [{ boardId: "b-right", boardName: "Right", slotId: "bare", channel: "01", index: 2 }],
    });
  });
});

describe("the older routes, as aliases onto the board a screen shows", () => {
  it("POST /api/layout-objects/:id/slots writes the widget's board", async () => {
    const r = await call(viewRoutes, "/api/layout-objects/g-1/slots", "POST", { slots: [slot("w")] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(ids(await slotsStore.getDefault("b-left", TYPE)), ["w"]);
  });

  it("POST /api/slots (the phone control page) writes the board of the screen it names", async () => {
    const r = await call(serviceCueRoutes, "/api/slots", "POST", { displayId: "display-1", slots: [slot("phone")] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(ids(await slotsStore.getDefault("b-left", TYPE)), ["phone"]);
    assert.deepEqual(ids(ctl.state.slotsByView["wall-2"]), ["phone"]);
  });

  it("preset apply by viewId lands on the screen's board", async () => {
    await presetsStore.save([{ id: "p1", name: "One", slots: [slot("p")], createdAt: NOW }]);
    const r = await call(presetRoutes, "/api/presets/p1/apply", "POST", { viewId: "wall-3", target: { kind: "default", serviceTypeId: TYPE } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await slotsStore.getDefault("b-right", TYPE)).length, 1);
  });

  it("POST /api/presets with boardId saves that board, remembering where it came from", async () => {
    await slotsStore.setDefault("b-right", TYPE, [slot("r")]);
    await ctl.loadAllViewRawSlots(TYPE, null);
    const r = await call(presetRoutes, "/api/presets", "POST", { name: "Right now", boardId: "b-right" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const saved = (await presetsStore.load()).find((p) => p.name === "Right now");
    assert.equal(saved?.boardId, "b-right");
    assert.equal(saved?.slots.length, 1);
  });

  it("PATCH /api/views/:id with { slotsLayout } splits the two widths between the screen and its board", async () => {
    const r = await call(viewRoutes, "/api/views/wall-1", "PATCH", { slotsLayout: { displayWidthIn: 30, columnWidthIn: 3.8 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(ctl.state.views.find((v) => v.id === "wall-1")!.slotsLayout, { displayWidthIn: 30 });
    assert.equal((await slotsStore.listBoards()).get("b-left")?.columnWidthIn, 3.8);
  });
});

describe("pointing a screen or widget at a board", () => {
  it("PUT /api/views/:id/board points a slots screen, or refuses another kind", async () => {
    await slotsStore.setDefault("b-right", TYPE, [slot("r")]);
    await ctl.loadAllViewRawSlots(TYPE, null);
    const r = await call(viewRoutes, "/api/views/wall-1/board", "PUT", { boardId: "b-right" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(ids(ctl.state.slotsByView["wall-1"]), ["r"]);
    assert.equal((await call(viewRoutes, "/api/views/pad/board", "PUT", { boardId: "b-right" })).status, 400);
    assert.equal((await call(viewRoutes, "/api/views/wall-1/board", "PUT", { boardId: "b-nope" })).status, 404);
  });

  it("a layout save pointing a widget at a board that does not exist is refused", async () => {
    const layout = { version: 1, canvas: { width: 1920, height: 1080 }, objects: [{ id: "g-1", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", boardId: "b-nope" } }] };
    const r = await call(viewRoutes, "/api/views/pad", "PATCH", { layout });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /no board b-nope/);
  });

  it("a layout save from an editor before boards is pointed: an inline widget keeps the board it shows", async () => {
    const layout = {
      version: 1, canvas: { width: 1920, height: 1080 },
      objects: [
        { id: "g-1", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", source: "inline", slotsLayout: { displayWidthIn: 21, columnWidthIn: 3.6 } } },
        { id: "g-new", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", source: "inline" } },
        { id: "g-embed", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", source: "view", sourceViewId: "wall-3" } },
      ],
    };
    const r = await call(viewRoutes, "/api/views/pad", "PATCH", { layout });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const configs = ctl.state.views.find((v) => v.id === "pad")!.layout!.objects.map((o) => o.config);
    assert.deepEqual(configs, [
      { type: "slots-grid", boardId: "b-left", displayWidthIn: 21 },
      { type: "slots-grid", boardId: "g-new" },
      { type: "slots-grid", boardId: "b-right" },
    ]);
    assert.equal(ctl.boards.get("b-left")?.columnWidthIn, 3.6, "the widget's column width did not reach its board");
    assert.equal(ctl.boards.get("g-new")?.name, "Stage Layout · widget");
  });
});
