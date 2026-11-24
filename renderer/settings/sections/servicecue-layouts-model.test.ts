// What the ServiceCue layouts page computes apart from React: where a drop lands, what a
// Columns change saves, and the words the page uses. The page's own tests drive these
// through the rendered section; here each is held to its exact answer.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { ServiceCueLayout } from "../../../main/types/pco.js";
import type { CategoryRole } from "../../../main/types/servicecue-roles.js";
import { insertIndex, stackIndex, type Rect } from "./servicecue-drag.js";
import { columnPatch, copyName, duplicateLayout, moveTo, noticeText, placeDrawn, reorderLayouts, trayItems } from "./servicecue-layouts-model.js";

const box = (left: number, top: number, w = 80, h = 30): Rect => ({ left, top, right: left + w, bottom: top + h });

describe("where a pointer drop lands", () => {
  // Two lines of chips: three on the first, one on the second.
  const chips = [box(0, 0), box(90, 0), box(180, 0), box(0, 40)];

  test("before the chip under the pointer's left half, after it on its right half", () => {
    assert.equal(insertIndex(chips, 100, 15), 1);
    assert.equal(insertIndex(chips, 160, 15), 2);
    assert.equal(insertIndex(chips, 250, 15), 3);
  });

  test("a point level with a line picks that line, however far along it", () => {
    // Level with the second line, far to its right: the end of the row, not of the line above.
    assert.equal(insertIndex(chips, 300, 55), 4);
    assert.equal(insertIndex(chips, 10, 50), 3);
    assert.equal(insertIndex(chips, 130, 50), 4, "the first line's chip above is nearer by width alone");
  });

  test("an empty row takes the drop at its start", () => {
    assert.equal(insertIndex([], 40, 40), 0);
  });

  test("a card goes before the first card whose middle is below the pointer", () => {
    const cards = [box(0, 0, 600, 50), box(0, 60, 600, 50), box(0, 120, 600, 50)];
    assert.equal(stackIndex(cards, 10), 0);
    assert.equal(stackIndex(cards, 30), 1);
    assert.equal(stackIndex(cards, 200), 3);
  });
});

const layout = (id: string, order: number, extra: Partial<ServiceCueLayout> = {}): ServiceCueLayout => ({ id, name: id, order, ...extra });

describe("what a change saves", () => {
  test("moveTo counts the list without the item moved", () => {
    assert.deepEqual(moveTo(["a", "b", "c"], "a", 2), ["b", "c", "a"]);
    assert.deepEqual(moveTo(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
    assert.deepEqual(moveTo(["a", "b"], "z", 1), ["a", "z", "b"], "an item not in the list is inserted");
  });

  const role = (id: string): CategoryRole => ({ id, name: id.toUpperCase(), members: [id] });
  const ROLES = ["a", "b", "c"].map(role);

  test("a role added from the tray lands where it was dropped, or last", () => {
    const l = layout("l", 0, { columnRoles: ["a", "b"] });
    assert.deepEqual(columnPatch(l, { kind: "add-role", roleId: "c", index: 1 }, ROLES), { columnRoles: ["a", "c", "b"] });
    assert.deepEqual(columnPatch(l, { kind: "add-role", roleId: "c" }, ROLES), { columnRoles: ["a", "b", "c"] });
  });

  // A layout imported without its roles names ids this install has none of. They draw
  // nothing, so a drop index counts the drawn columns, and the ghosts keep their slots.
  test("a move counts the columns drawn, past an id no role has", () => {
    const l = layout("l", 0, { columnRoles: ["ghost", "a", "b"] });
    assert.deepEqual(
      columnPatch(l, { kind: "move-role", roleId: "a", index: 1 }, ROLES),
      { columnRoles: ["ghost", "b", "a"] },
      "dragging A after B saved the list unchanged",
    );
    assert.deepEqual(columnPatch(l, { kind: "move-role", roleId: "b", index: 0 }, ROLES), { columnRoles: ["ghost", "b", "a"] });
    const mid = layout("l", 0, { columnRoles: ["a", "ghost", "b"] });
    assert.deepEqual(columnPatch(mid, { kind: "move-role", roleId: "b", index: 0 }, ROLES), { columnRoles: ["b", "ghost", "a"] });
  });

  test("an add counts the columns drawn, past an id no role has", () => {
    const l = layout("l", 0, { columnRoles: ["ghost", "a", "b"] });
    assert.deepEqual(columnPatch(l, { kind: "add-role", roleId: "c", index: 0 }, ROLES), { columnRoles: ["ghost", "c", "a", "b"] });
    assert.deepEqual(columnPatch(l, { kind: "add-role", roleId: "c", index: 2 }, ROLES), { columnRoles: ["ghost", "a", "b", "c"] });
  });

  test("a keyboard reorder of the drawn columns keeps the ids no role has", () => {
    assert.deepEqual(placeDrawn(["a", "ghost", "b"], new Set(["a", "b"]), ["b", "a"]), ["b", "ghost", "a"]);
  });

  test("reordered layouts are renumbered from 0 in the new order", () => {
    const out = reorderLayouts([layout("a", 0), layout("b", 1), layout("c", 2)], ["c", "a", "b"]);
    assert.deepEqual(out.map((l) => `${l.id}:${l.order}`), ["c:0", "a:1", "b:2"]);
  });

  test("a copy takes a free name and no address of its own until the server gives it one", () => {
    const list = [layout("a", 0, { name: "Audio", slug: "audio" }), layout("b", 1, { name: "audio COPY" })];
    assert.equal(copyName("Audio", list), "Audio copy 2", "names compare as the server compares them");
    const out = duplicateLayout(list, "a", "new");
    assert.deepEqual(out.map((l) => `${l.id}:${l.order}`), ["a:0", "new:1", "b:2"]);
    assert.equal(out[1].slug, undefined);
    assert.equal(out[1].autoNamed, true);
  });

  test("the tray lists what is off in the row's own order", () => {
    const roles = [{ id: "r1", name: "Audio", members: [] }, { id: "r2", name: "Video", members: [] }];
    const l = layout("l", 0, { columnRoles: ["r2"], showLength: false });
    assert.deepEqual(trayItems(l, roles).map((t) => t.name), ["Time", "Audio", "Max SPL"]);
  });

  test("a role with no categories is marked empty in the tray; one with a category is not", () => {
    const roles = [{ id: "r1", name: "Audio", members: ["Audio"] }, { id: "r2", name: "Video", members: [] }];
    const out = trayItems(layout("l", 0, { columnRoles: [] }), roles).flatMap((t) => (t.kind === "role" ? [`${t.name}:${t.empty}`] : []));
    assert.deepEqual(out, ["Audio:false", "Video:true"]);
  });
});

describe("the notice's words", () => {
  test("one category: singular throughout", () => {
    assert.deepEqual(noticeText([{ typeName: "Youth", cats: ["Graphics"] }]), {
      lead: "Graphics from Youth is in no role",
      rest: ", so no layout can show it as a column.",
      still: "It still appears under All columns.",
    });
  });

  test("several from one type join with 'and', and groups with ', and ' once any has more than one", () => {
    const t = noticeText([{ typeName: "Sunday", cats: ["Graphics", "Lyrics", "Props"] }, { typeName: "Youth", cats: ["Games"] }]);
    assert.equal(t.lead, "Graphics, Lyrics and Props from Sunday, and Games from Youth are in no role");
    assert.equal(t.still, "They still appear under All columns.");
  });
});
