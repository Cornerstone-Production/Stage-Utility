import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unassignedByType, unassignedDistinct } from "../../../../settings/sections/servicecue-layouts-model.js";
import { attentionInput } from "../test-input.js";
import { noteCategories } from "./note-categories.js";

type Cover = import("../types.js").NoteCategoryInput;

const ROLES = [
  { id: "r-audio", name: "Audio", members: ["Audio", "Sound"] },
  { id: "r-light", name: "Lighting", members: ["Lighting"] },
];
const cover = (over: Partial<Cover> = {}): Cover => ({
  known: true,
  roles: ROLES,
  landingTypeIds: ["wk"],
  catsByType: new Map([["wk", ["Audio", "Lighting", "Stage notes", "Prayer"]]]),
  ...over,
});
const run = (noteCategories_: Cover) => noteCategories.items(attentionInput({ noteCategories: noteCategories_ }));

describe("note-categories source", () => {
  it("fires once for the categories no role claims: the count, the names, and Open roles", () => {
    const items = run(cover());
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.severity, "warn");
    assert.equal(item.title, "2 note categories are in no column");
    assert.equal(item.detail, "Stage notes and Prayer show only under All columns.");
    assert.deepEqual(item.fix, { label: "Open roles", route: "/servicecue/presets", flash: "servicecue-roles" });
    assert.match(item.key, /^note-categories:/);
  });

  it("says it in the singular for one", () => {
    const [item] = run(cover({ catsByType: new Map([["wk", ["Audio", "Prayer"]]]) }));
    assert.equal(item.title, "1 note category is in no column");
    assert.equal(item.detail, "Prayer shows only under All columns.");
  });

  it("counts the layouts page notice's own set: the same functions, over the landing page's types, one name once", () => {
    // Two types that both name Prayer: it is one category the operator makes one role for.
    const input = cover({ landingTypeIds: ["wk", "mid"], catsByType: new Map([["wk", ["Audio", "Prayer"]], ["mid", ["Prayer", "Stage notes"]], ["off", ["Hidden"]]]) });
    const expected = unassignedDistinct(unassignedByType(input.roles, input.landingTypeIds, input.catsByType)).map((e) => e.name);
    const [item] = run(input);
    assert.deepEqual(expected, ["Prayer", "Stage notes"]);
    assert.equal(item.title, `${expected.length} note categories are in no column`);
    assert.equal(item.detail.includes("Hidden"), false, "a type off the landing page is not counted");
  });

  it("is quiet at none, with no landing type, before the roles are read, and on a first run with no roles", () => {
    assert.deepEqual(run(cover({ catsByType: new Map([["wk", ["Audio", "Lighting", "Sound"]]]) })), [], "all covered");
    assert.deepEqual(run(cover({ landingTypeIds: [] })), [], "no landing type ticked");
    assert.deepEqual(run(cover({ known: false })), [], "a source that has not answered contributes nothing");
    assert.deepEqual(run(cover({ roles: [] })), [], "no roles at all: the layouts page does not warn on a first run either");
  });

  it("reordering the landing types does not change the key, so it does not un-snooze the row", () => {
    const a = run(cover({ landingTypeIds: ["wk", "mid"], catsByType: new Map([["wk", ["Prayer"]], ["mid", ["Stage notes"]]]) }))[0].key;
    const b = run(cover({ landingTypeIds: ["mid", "wk"], catsByType: new Map([["wk", ["Prayer"]], ["mid", ["Stage notes"]]]) }))[0].key;
    assert.equal(a, b);
  });

  it("a change in the set is a different key, so a new category is not hidden by an old snooze", () => {
    const a = run(cover({ catsByType: new Map([["wk", ["Audio", "Prayer"]]]) }))[0].key;
    const b = run(cover({ catsByType: new Map([["wk", ["Audio", "Prayer", "Stage notes"]]]) }))[0].key;
    assert.notEqual(a, b);
  });
});
