import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { CAPABILITIES } from "@main/types/object-capabilities";
import { LAYOUT_OBJECTS, PALETTE_GROUP_ORDER } from "./layout-objects.js";

// The palette shows every object as a card: name, one line of description, and
// the group it belongs to. A card with a bare name and no explanation is a card
// nobody can choose from, so `blurb` is a required field on the spec and `tsc`
// refuses a type without one — this file guards the things the type system
// cannot: that the text is actually useful, and that the count is what we think.

const TYPES = Object.keys(LAYOUT_OBJECTS) as (keyof typeof LAYOUT_OBJECTS)[];

describe("the catalog covers every object type", () => {
  test("exactly 55 types, and the two registries agree", () => {
    // An EXACT count, not a floor. The design doc said 38 while the capability
    // registry held 41; nothing noticed for three releases.
    assert.equal(TYPES.length, 55);
    assert.deepEqual(
      TYPES.slice().sort(),
      Object.keys(CAPABILITIES).sort(),
      "every capability-registry type needs a spec, and vice versa",
    );
  });
});

describe("every blurb is usable on a card", () => {
  for (const t of TYPES) {
    test(`${t}`, () => {
      const b = LAYOUT_OBJECTS[t].blurb;
      assert.ok(b.length > 0, "must not be empty");
      assert.ok(b.length <= 60, `must fit one line, got ${b.length} chars`);

      // A blurb that restates the label teaches nothing. "OBS status" under a
      // card titled "OBS status" is the failure this catches.
      const label = LAYOUT_OBJECTS[t].label.toLowerCase();
      assert.notEqual(b.toLowerCase(), label, "must not just repeat the label");

      // Sentence case, no trailing full stop - these are captions, not prose.
      assert.doesNotMatch(b, /\.$/, "no trailing full stop");
      assert.match(b, /^[A-Z]/, "starts with a capital");
    });
  }
});

describe("grouping", () => {
  test("every palette group is used by at least one type", () => {
    // An empty group is a heading with nothing under it.
    const used = new Set(TYPES.map((t) => LAYOUT_OBJECTS[t].group).filter(Boolean));
    for (const g of PALETTE_GROUP_ORDER) {
      assert.ok(used.has(g), `palette group "${g}" has no objects in it`);
    }
  });

  test("a type kept out of the palette says so deliberately", () => {
    // group: null means "not offered by hand" (NDI is placed by the native
    // client). It must still carry a blurb, because it appears in the layer
    // list and the inspector.
    for (const t of TYPES) {
      if (LAYOUT_OBJECTS[t].group === null) {
        assert.ok(LAYOUT_OBJECTS[t].blurb.length > 0, `${t} still needs a blurb`);
      }
    }
  });
});
