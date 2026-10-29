// The v3 → v4 move onto named boards, over an install shaped like a real one.
//
// Two slots screens (Left, Right), a custom "Stage Layout" view whose own inline
// grid copied the Right screen's boards and then drifted on one service type, a
// second custom view whose inline grid is an exact copy of the Left screen's, a
// grid that embeds the Left screen, and a key nothing points at any more. Every
// id and name is invented; the shape is the one that motivated boards.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { migrateBoards } from "./slot-boards.js";
import type { SlotsFile, SlotsOverride } from "./slots-store.js";
import type { LayoutObject, Slot, View } from "../types/stage.js";

const NOW = "2026-10-29T12:00:00.000Z";
const WEEKEND = "st-weekend";
const EVENTS = "st-events";

/** A slot as a layout: what matters is the link and channel; the id differs per copy. */
const s = (id: string, position: string, channel: string, order: number): Slot =>
  ({ id, channel, order, link: { kind: "pco", matchBy: "position", positions: [{ name: position }] }, deviceBinding: null }) as unknown as Slot;

const lineup = (prefix: string, names: string[]) => names.map((n, i) => s(`${prefix}-${i}`, n, String(i + 1).padStart(2, "0"), i));

const grid = (id: string, config: Record<string, unknown>) =>
  ({ id, x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", ...config } }) as unknown as LayoutObject;

const custom = (id: string, name: string, objects: LayoutObject[]): View =>
  ({ id, name, kind: "custom", createdAt: "", layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects } }) as unknown as View;

function henryViews(): View[] {
  return [
    { id: "display-1", name: "Left Display", kind: "slots", createdAt: "", slotsLayout: { displayWidthIn: 32.25, columnWidthIn: 3.49 } },
    { id: "display-2", name: "Right Display", kind: "slots", createdAt: "", slotsLayout: { displayWidthIn: 32.25, columnWidthIn: 3.49 } },
    custom("view-2", "Right Display - Stage Layout", [grid("g-right", { source: "inline", sourceViewId: null, slotsLayout: { displayWidthIn: 20, columnWidthIn: 3.49 } })]),
    custom("view-3", "Left Confidence", [grid("g-left-copy", { source: "inline", slotsLayout: { displayWidthIn: 24, columnWidthIn: 3.49 } })]),
    custom("view-4", "Producer", [
      { id: "wrap", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "container" }, children: [grid("g-embed", { source: "view", sourceViewId: "display-1" })] } as unknown as LayoutObject,
    ]),
  ] as unknown as View[];
}

const left = ["Pastor", "Host", "Vocals"];
const rightWeekend = ["Keys", "Bass", "Drums"];
const rightEvents = ["Keys", "Bass"];
const bandLineup = ["Keys", "Bass", "Drums", "EG", "AG"];

function henryFile(): SlotsFile {
  const byType = (w: Slot[], e: Slot[]) => new Map([[WEEKEND, w], [EVENTS, e]]);
  const override = (slots: Slot[]): Map<string, SlotsOverride> => new Map([["plan-9", { serviceTypeId: WEEKEND, sortDate: "2026-11-01", slots }]]);
  return {
    version: 3,
    boards: new Map(),
    defaults: new Map([
      ["display-1", byType(lineup("l", left), lineup("le", left))],
      ["display-2", byType(lineup("r", rightWeekend), lineup("re", rightEvents))],
      // Weekend equals display-2's (other slot ids); Events holds the band lineup.
      ["g-right", byType(lineup("gr", rightWeekend), lineup("gre", bandLineup))],
      // display-1 to the letter, with different slot ids.
      ["g-left-copy", byType(lineup("glc", left), lineup("glce", left))],
      ["obj-gone", new Map([[WEEKEND, lineup("x", ["Choir"])]])],
    ]),
    overrides: new Map([
      ["display-1", override(lineup("lo", ["Pastor"]))],
      ["g-left-copy", override(lineup("glco", ["Pastor"]))],
    ]),
  };
}

const gridOf = (views: View[], viewId: string, objectId: string) => {
  let found: LayoutObject | undefined;
  const walk = (objs: LayoutObject[]) => objs.forEach((o) => { if (o.id === objectId) found = o; if (o.children) walk(o.children); });
  walk(views.find((v) => v.id === viewId)!.layout!.objects);
  return found!.config as Record<string, unknown>;
};

describe("which identical board survives", () => {
  test("a screen's board survives over a widget's even when the widget's id sorts first", () => {
    // Widget ids are random UUIDs, so one can sort before "display-1". The merged
    // board must keep the screen's id and name, not "… · widget".
    const rename = (x: string) => x.replaceAll("g-left-copy", "0a1b2c3d");
    const views = JSON.parse(rename(JSON.stringify(henryViews()))) as View[];
    const file = henryFile();
    for (const half of [file.defaults, file.overrides] as Map<string, unknown>[]) {
      half.set("0a1b2c3d", half.get("g-left-copy"));
      half.delete("g-left-copy");
    }
    const result = migrateBoards(views, file, NOW);
    assert.equal(result.file.boards.get("display-1")?.name, "Left Display");
    assert.equal(result.file.boards.has("0a1b2c3d"), false);
    assert.equal(gridOf(result.views, "view-3", "0a1b2c3d").boardId, "display-1");
  });
});

describe("migrating an install shaped like a real one", () => {
  const result = migrateBoards(henryViews(), henryFile(), NOW);

  test("makes one board per key, named after its screen or widget, keeping the key as its id", () => {
    const boards = Object.fromEntries([...result.file.boards].map(([id, b]) => [id, [b.name, b.columnWidthIn]]));
    assert.deepEqual(boards, {
      "display-1": ["Left Display", 3.49],
      "display-2": ["Right Display", 3.49],
      "g-right": ["Right Display - Stage Layout · widget", 3.49],
      "obj-gone": ["Unused board 1", null],
    });
    assert.equal(result.file.version, 4);
  });

  test("moves no slot data: each board's layouts are the key's, untouched", () => {
    assert.deepEqual(result.file.defaults.get("display-2"), henryFile().defaults.get("display-2"));
    assert.deepEqual(result.file.defaults.get("g-right"), henryFile().defaults.get("g-right"));
    assert.deepEqual(result.file.overrides.get("display-1"), henryFile().overrides.get("display-1"));
  });

  test("keeps a widget whose board drifted on ONE service type as a board of its own", () => {
    // Weekend is identical to the Right screen's; Events holds the band. Merging
    // it would lose the band lineup, so it stays for the operator to review.
    assert.ok(result.file.boards.has("g-right"));
    assert.equal(gridOf(result.views, "view-2", "g-right").boardId, "g-right");
  });

  test("collapses an exact copy onto the lowest id, moving its pointer and dropping its entries", () => {
    assert.equal(result.file.boards.has("g-left-copy"), false);
    assert.equal(result.file.defaults.has("g-left-copy"), false);
    assert.equal(result.file.overrides.has("g-left-copy"), false);
    assert.equal(gridOf(result.views, "view-3", "g-left-copy").boardId, "display-1");
  });

  test("points every screen and widget", () => {
    assert.deepEqual(result.views.filter((v) => v.kind === "slots").map((v) => [v.id, v.boardId]), [["display-1", "display-1"], ["display-2", "display-2"]]);
    // The grid that embedded the Left screen now shares its board, drawn at the
    // display width it was drawn with: the embedded screen's.
    assert.deepEqual(gridOf(result.views, "view-4", "g-embed"), { type: "slots-grid", boardId: "display-1", displayWidthIn: 32.25 });
    assert.deepEqual(gridOf(result.views, "view-2", "g-right"), { type: "slots-grid", boardId: "g-right", displayWidthIn: 20 });
    assert.deepEqual(gridOf(result.views, "view-3", "g-left-copy"), { type: "slots-grid", boardId: "display-1", displayWidthIn: 24 });
  });

  test("leaves each screen only its display width", () => {
    assert.deepEqual(result.views.find((v) => v.id === "display-1")!.slotsLayout, { displayWidthIn: 32.25 });
  });

  test("says what it did, once per decision", () => {
    assert.deepEqual(result.log, [
      "migrated slots.json v3 → v4: 4 board(s) from 5 key(s), 1 merged, 1 unused",
      'merged board "Left Confidence · widget" (g-left-copy) into "Left Display" (display-1) (identical layouts)',
      'kept unused board "Unused board 1" (obj-gone): no screen or widget shows it',
    ]);
    assert.equal(result.changed, true);
  });

  test("is idempotent: run over its own output it changes nothing and says nothing", () => {
    const again = migrateBoards(result.views, result.file, "2027-01-01T00:00:00.000Z");
    assert.equal(again.changed, false);
    assert.deepEqual(again.log, []);
    assert.deepEqual(again.views, result.views);
    assert.deepEqual([...again.file.boards], [...result.file.boards]);
  });

  test("does not touch what it was given", () => {
    const views = henryViews();
    const file = henryFile();
    migrateBoards(views, file, NOW);
    assert.deepEqual(views, henryViews());
    assert.deepEqual(file, henryFile());
  });
});

describe("what does not collapse", () => {
  const two = (a: Slot[], b: Slot[], widths: [number, number] = [3.49, 3.49]) =>
    migrateBoards(
      [
        { id: "a", name: "A", kind: "slots", createdAt: "", slotsLayout: { displayWidthIn: 30, columnWidthIn: widths[0] } },
        { id: "b", name: "B", kind: "slots", createdAt: "", slotsLayout: { displayWidthIn: 30, columnWidthIn: widths[1] } },
      ] as unknown as View[],
      { version: 3, boards: new Map(), defaults: new Map([["a", new Map([[WEEKEND, a]])], ["b", new Map([[WEEKEND, b]])]]), overrides: new Map() },
      NOW,
    );

  test("boards one slot apart", () => {
    const r = two(lineup("a", left), [...lineup("b", left).slice(0, 2), s("b-2", "Vocals", "09", 2)]);
    assert.deepEqual([...r.file.boards.keys()].sort(), ["a", "b"]);
  });

  test("identical layouts at different column widths", () => {
    const r = two(lineup("a", left), lineup("b", left), [3.49, 4]);
    assert.deepEqual([...r.file.boards.keys()].sort(), ["a", "b"]);
  });

  test("two empty screens: two screens nobody has built yet are not one board", () => {
    const r = migrateBoards(
      [{ id: "a", name: "A", kind: "slots", createdAt: "" }, { id: "b", name: "B", kind: "slots", createdAt: "" }] as unknown as View[],
      { version: 3, boards: new Map(), defaults: new Map(), overrides: new Map() },
      NOW,
    );
    assert.deepEqual([...r.file.boards.keys()].sort(), ["a", "b"]);
  });

  test("two identical boards that already existed: an operator's boards are never merged", () => {
    const meta = { name: "Copy", columnWidthIn: null, createdAt: NOW };
    const r = migrateBoards(
      [{ id: "a", name: "A", kind: "slots", createdAt: "", boardId: "b-1" }, { id: "b", name: "B", kind: "slots", createdAt: "", boardId: "b-2" }] as unknown as View[],
      {
        version: 4,
        boards: new Map([["b-1", meta], ["b-2", meta]]),
        defaults: new Map([["b-1", new Map([[WEEKEND, lineup("x", left)]])], ["b-2", new Map([[WEEKEND, lineup("y", left)]])]]),
        overrides: new Map(),
      },
      NOW,
    );
    assert.deepEqual([...r.file.boards.keys()], ["b-1", "b-2"]);
    assert.equal(r.changed, false);
  });
});

describe("a v4 install that something from before boards wrote to", () => {
  test("a widget saved in the old shape is pointed again and loses the old fields", () => {
    const r = migrateBoards(
      [custom("pad", "Pad", [grid("g-new", { source: "inline", slotsLayout: { displayWidthIn: 10, columnWidthIn: 2 } })])],
      { version: 4, boards: new Map(), defaults: new Map(), overrides: new Map() },
      NOW,
    );
    assert.deepEqual(gridOf(r.views, "pad", "g-new"), { type: "slots-grid", boardId: "g-new", displayWidthIn: 10 });
    assert.deepEqual(r.file.boards.get("g-new"), { name: "Pad · widget", columnWidthIn: 2, createdAt: NOW });
    assert.deepEqual(r.log, ["added 1 board(s) for slots nothing had a board for"]);
  });

  test("a screen whose board was deleted with nothing in its place keeps pointing at nothing", () => {
    const r = migrateBoards(
      [{ id: "a", name: "A", kind: "slots", createdAt: "", boardId: null }] as unknown as View[],
      { version: 4, boards: new Map(), defaults: new Map(), overrides: new Map() },
      NOW,
    );
    assert.equal(r.views[0]!.boardId, null);
    assert.equal(r.file.boards.size, 0, "a board was made for a screen deliberately showing none");
    assert.equal(r.changed, false);
  });
});

describe("a widget that embedded a view that is not a slots screen", () => {
  // Only a slots view's rows were ever drawn through an embed. The key of a
  // deleted view (or of a view since turned into a layout) can still hold a
  // lineup nobody has looked at for months.
  const stale = (): SlotsFile => ({
    version: 3,
    boards: new Map(),
    defaults: new Map([["view-gone", new Map([[WEEKEND, lineup("x", ["Choir"])]])], ["view-9", new Map([[WEEKEND, lineup("y", ["Band"])]])]]),
    overrides: new Map(),
  });
  const views = (): View[] => [
    custom("view-9", "Was a screen", []),
    custom("pad", "Pad", [grid("g-dead", { source: "view", sourceViewId: "view-gone" }), grid("g-custom", { source: "view", sourceViewId: "view-9" })]),
  ];

  test("points at nothing, as it drew nothing, and the stale rows are kept on an unused board", () => {
    const r = migrateBoards(views(), stale(), NOW);
    assert.equal(gridOf(r.views, "pad", "g-dead").boardId, null, "a widget embedding a deleted view starts drawing its stale rows");
    assert.equal(gridOf(r.views, "pad", "g-custom").boardId, null, "a widget embedding a custom view starts drawing its stale rows");
    assert.deepEqual(r.file.boards.get("view-gone")?.name, "Unused board 1");
    assert.ok(r.file.defaults.has("view-gone"), "the stale rows were dropped");
  });
});

describe("a v4 pointer at a board that does not exist", () => {
  const meta = { name: "Kept", columnWidthIn: null, createdAt: NOW };

  test("is cleared and named, never given a new empty board", () => {
    const r = migrateBoards(
      [
        { id: "a", name: "A", kind: "slots", createdAt: "", boardId: "b-gone" },
        { id: "z", name: "Z", kind: "slots", createdAt: "", boardId: "b-1" },
        custom("pad", "Pad", [grid("g-1", { boardId: "b-gone" })]),
        // Dormant: a slots view keeping the layout it had as a custom view.
        { ...custom("old", "Old", [grid("g-2", { boardId: "b-gone" })]), kind: "slots", boardId: "b-1" },
      ] as unknown as View[],
      { version: 4, boards: new Map([["b-1", meta]]), defaults: new Map(), overrides: new Map() },
      NOW,
    );
    assert.equal(r.views.find((v) => v.id === "a")!.boardId, null);
    assert.equal(gridOf(r.views, "pad", "g-1").boardId, null);
    assert.equal(gridOf(r.views, "old", "g-2").boardId, null);
    assert.deepEqual([...r.file.boards.keys()], ["b-1"], "a phantom board was made for a dangling pointer");
    assert.equal(r.changed, true);
    assert.deepEqual(r.log, [
      '"A" (a) pointed at board b-gone, which does not exist; it now shows none',
      'a slots widget (g-1) on "Pad" pointed at board b-gone, which does not exist; it now shows none',
      'a slots widget (g-2) on "Old" pointed at board b-gone, which does not exist; it now shows none',
    ]);
  });

  test("but a pointer at rows that have no board yet gets one", () => {
    const r = migrateBoards(
      [{ id: "a", name: "A", kind: "slots", createdAt: "", boardId: "a" }] as unknown as View[],
      { version: 4, boards: new Map(), defaults: new Map([["a", new Map([[WEEKEND, lineup("x", left)]])]]), overrides: new Map() },
      NOW,
    );
    assert.equal(r.views[0]!.boardId, "a");
    assert.equal(r.file.boards.get("a")?.name, "A");
  });
});

describe("what makes two boards different", () => {
  // Merging deletes the loser's rows, so anything the signature leaves out is
  // something a merge throws away.
  const twoBoards = (a: { defaults?: Slot[]; override?: Slot[] }, b: { defaults?: Slot[]; override?: Slot[] }) => {
    const ov = (slots: Slot[]): Map<string, SlotsOverride> => new Map([["plan-9", { serviceTypeId: WEEKEND, sortDate: "2026-11-01", slots }]]);
    const defaults = new Map<string, Map<string, Slot[]>>();
    const overrides = new Map<string, Map<string, SlotsOverride>>();
    for (const [id, x] of [["a", a], ["b", b]] as const) {
      if (x.defaults) defaults.set(id, new Map([[WEEKEND, x.defaults]]));
      if (x.override) overrides.set(id, ov(x.override));
    }
    return migrateBoards(
      [{ id: "a", name: "A", kind: "slots", createdAt: "" }, { id: "b", name: "B", kind: "slots", createdAt: "" }] as unknown as View[],
      { version: 3, boards: new Map(), defaults, overrides },
      NOW,
    );
  };

  test("one plan's rows", () => {
    const r = twoBoards(
      { defaults: lineup("a", left), override: lineup("ao", ["Pastor"]) },
      { defaults: lineup("b", left), override: lineup("bo", ["Host"]) },
    );
    assert.deepEqual([...r.file.boards.keys()].sort(), ["a", "b"], "two boards differing only in one plan's rows were merged");
  });

  test("a static slot's own name, which the resolver keeps as stored", () => {
    // A pco slot's displayName is filled in on every read, so it is not layout;
    // a static slot's is what it shows.
    const stat = (id: string, displayName: string): Slot =>
      ({ id, channel: "01", order: 0, link: { kind: "static", label: "Guest", color: "#2E6691" }, displayName, deviceBinding: null }) as unknown as Slot;
    const r = twoBoards({ defaults: [stat("a1", "Pastor Sam")] }, { defaults: [stat("b1", "Pastor Jo")] });
    assert.deepEqual([...r.file.boards.keys()].sort(), ["a", "b"], "two boards differing only in a static slot's name were merged");
  });
});

describe("the writes a merge needs", () => {
  test("stage the merged board, kept and named, before the views stop pointing at it", () => {
    const r = migrateBoards(henryViews(), henryFile(), NOW);
    assert.ok(r.staged, "a merge with no staged file");
    assert.deepEqual([...r.staged.pendingMerges!], [["g-left-copy", "display-1"]]);
    assert.ok(r.staged.boards.has("g-left-copy") && r.staged.defaults.has("g-left-copy") && r.staged.overrides.has("g-left-copy"));
    assert.equal(r.file.pendingMerges, undefined);
    assert.equal(r.file.boards.has("g-left-copy"), false);
  });

  test("a recorded merge is finished on the next run", () => {
    const first = migrateBoards(henryViews(), henryFile(), NOW);
    // Died after the views were written: slots.json is the staged one.
    const next = migrateBoards(first.views, first.staged!, NOW);
    assert.equal(next.viewsChanged, false);
    assert.equal(next.fileChanged, true);
    assert.deepEqual([...next.file.boards.keys()].sort(), [...first.file.boards.keys()].sort());
    assert.equal(next.file.pendingMerges, undefined);
  });

  test("a recorded merge whose boards are no longer identical keeps both", () => {
    const first = migrateBoards(henryViews(), henryFile(), NOW);
    const staged = first.staged!;
    staged.defaults.set("g-left-copy", new Map([[WEEKEND, lineup("new", ["Edited"])]]));
    const next = migrateBoards(first.views, staged, NOW);
    assert.ok(next.file.boards.has("g-left-copy"), "a board edited since the merge was recorded was deleted");
    assert.deepEqual(next.file.defaults.get("g-left-copy")?.get(WEEKEND)?.map((x) => x.id), ["new-0"]);
    assert.equal(next.file.pendingMerges, undefined);
  });
});
