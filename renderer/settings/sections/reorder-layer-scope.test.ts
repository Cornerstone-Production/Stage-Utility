// Reordering one sibling scope from the Layers panel.
//
// The defect this replaces: reordering happened in z-ASCENDING order under a rule
// of "insert before the target". There is no row above the first one to drop
// before, so the topmost slot was unreachable — the only way to promote something
// to the top was to drop it under the current top and then drag THAT one down
// past it. Two drags for one move, and no way to tell from the UI that the first
// had not worked.
//
// Everything here is expressed in the order the panel SHOWS — topmost first —
// because that is the order the operator is reasoning in.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { reorderLayerScope } from "./layout-editor";

/** Objects named by their z, so a display order reads as a list of names. */
function scope(...zs: number[]): LayoutObject[] {
  return zs.map((z) => ({
    id: `o${z}`, x: 0, y: 0, w: 1, h: 1, z,
    config: { type: "text", text: `o${z}` },
    style: {},
  })) as LayoutObject[];
}

/** What the Layers panel would render: highest z first. */
function display(list: LayoutObject[]): string[] {
  return [...list].sort((a, b) => b.z - a.z).map((o) => o.id);
}

describe("reorderLayerScope", () => {
  // Panel shows: o3, o2, o1  (top to bottom)
  const base = scope(1, 2, 3);

  it("promotes to the very top — the move that used to take two drags", () => {
    // Drop o1 above the topmost row.
    const out = reorderLayerScope(base, "o1", "o3", "above");
    assert.deepEqual(display(out), ["o1", "o3", "o2"]);
  });

  it("demotes to the very bottom", () => {
    const out = reorderLayerScope(base, "o3", "o1", "below");
    assert.deepEqual(display(out), ["o2", "o1", "o3"]);
  });

  it("drops on either side of a middle row, and the two differ", () => {
    const above = reorderLayerScope(base, "o3", "o2", "above");
    const below = reorderLayerScope(base, "o3", "o2", "below");
    assert.deepEqual(display(above), ["o3", "o2", "o1"], "above the middle row");
    assert.deepEqual(display(below), ["o2", "o3", "o1"], "below the middle row");
    assert.notDeepEqual(display(above), display(below), "the edge must actually change the result");
  });

  it("does not land a slot short when dragging downward", () => {
    // The classic off-by-one: computing the target index BEFORE removing the
    // dragged row shifts every later index by one.
    const four = scope(1, 2, 3, 4); // shows o4, o3, o2, o1
    const out = reorderLayerScope(four, "o4", "o2", "below");
    assert.deepEqual(display(out), ["o3", "o2", "o4", "o1"]);
  });

  it("keeps z a dense 1..n with no ties", () => {
    // A tie makes paint order fall back to array order — an object that appears
    // to move on its own, and cannot be reproduced from the saved layout.
    const out = reorderLayerScope(scope(1, 5, 9, 40), "o1", "o40", "above");
    const zs = [...out].map((o) => o.z).sort((a, b) => a - b);
    assert.deepEqual(zs, [1, 2, 3, 4]);
    assert.equal(new Set(zs).size, zs.length, "z values must be unique");
  });

  it("is a no-op for ids that are not in this scope", () => {
    assert.equal(reorderLayerScope(base, "nope", "o2", "above"), base);
    assert.equal(reorderLayerScope(base, "o1", "nope", "above"), base);
  });

  it("round-trips: every position is reachable in ONE move", () => {
    // The property the old rule broke. From any starting order, each of the three
    // slots must be reachable with a single drop.
    const reachable = new Set<string>();
    for (const target of ["o1", "o2", "o3"]) {
      for (const edge of ["above", "below"] as const) {
        if (target === "o2") continue; // moving o2 relative to itself is a no-op
        reachable.add(display(reorderLayerScope(base, "o2", target, edge)).join(","));
      }
    }
    assert.ok(reachable.has("o2,o3,o1"), "o2 must be able to reach the top in one move");
    assert.ok(reachable.has("o3,o1,o2"), "o2 must be able to reach the bottom in one move");
  });
});
