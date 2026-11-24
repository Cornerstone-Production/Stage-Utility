// layout-tree.ts: the tree edits the editor makes.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views";
import { replaceById } from "./layout-tree.js";

describe("replaceById", () => {
  const a = { id: "a" } as LayoutObject;
  const b = { id: "b" } as LayoutObject;
  const z = { id: "z" } as LayoutObject;
  const box = { id: "box", children: [a, b] } as LayoutObject;
  const other = { id: "other", children: [{ id: "c" } as LayoutObject] } as LayoutObject;

  test("replaces at the top level and inside a container, leaving the rest", () => {
    assert.deepEqual(
      replaceById([box, z], "b", [{ id: "1" } as LayoutObject, { id: "2" } as LayoutObject]).map((o) => [o.id, o.children?.map((c) => c.id)]),
      [
        ["box", ["a", "1", "2"]],
        ["z", undefined],
      ],
    );
    assert.deepEqual(replaceById([a, z], "z", []).map((o) => o.id), ["a"]);
  });

  test("an untouched subtree keeps its identity, and a tree without the id comes back as it was", () => {
    const tree = [box, other, z];
    const next = replaceById(tree, "b", []);
    assert.equal(next[1], other, "a container the replacement is not in was rebuilt");
    assert.equal(next[2], z);
    assert.notEqual(next[0], box);
    assert.equal(replaceById(tree, "nowhere", []), tree, "a tree without the id was rebuilt");
  });
});
