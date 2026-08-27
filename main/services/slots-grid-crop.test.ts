// A slots-grid draws in a box only the browser can measure — whichever source
// it reads.
//
// PCO's crop is centred and irreversible, so it may only be aimed at a shape
// something actually knows. A standalone slots DISPLAY is a row of tall columns
// and the crop is modelled on exactly that. A slots-grid OBJECT on a custom
// layout is a free-dragged rectangle, and that is true whether it defines its
// own slots or embeds another view's.
//
// The first pass gave "whole" only to inline grids, which left a view-sourced
// grid strictly worse than before: still cropped to a column, and no longer
// rescued by the `contain` rule that had been removed in the same change. A
// 158x1000 strip drawn with cover in a 260x175 cell shows about a tenth of a
// face.
//
// `source` is optional and predates the inline option, so "not inline" is the
// test — an older grid carrying no source at all is view-sourced.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { forEachInlineSlotsGrid, forEachViewSourcedSlotsGrid } from "./layout-clone.js";
import type { View } from "../types/views.js";

const grid = (id: string, source: string | undefined, sourceViewId: string | null) => ({
  id, x: 0, y: 0, w: 0.5, h: 0.3, z: 1,
  config: { type: "slots-grid", ...(source ? { source } : {}), sourceViewId },
});

const views = [{
  id: "v", name: "V", kind: "custom", ndiSource: null, createdAt: "", surface: "console",
  layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [
    grid("inline-1", "inline", null),
    grid("view-1", "view", "slots-a"),
    grid("legacy-1", undefined, "slots-b"),          // predates `source`
    { id: "wrap", x: 0, y: 0, w: 1, h: 1, z: 2, config: { type: "container" },
      children: [grid("nested-view", "view", "slots-c")] },
  ] },
}] as unknown as View[];

const collect = (fn: (v: View[], cb: (id: string, src: string) => void) => void) => {
  const out: string[] = [];
  fn(views, (id) => out.push(id));
  return out.sort();
};

describe("which grids get the whole image", () => {
  test("inline grids are found, and only those", () => {
    assert.deepEqual(collect(forEachInlineSlotsGrid as never), ["inline-1"]);
  });

  test("a grid embedding a view is found too — it is the same free-dragged box", () => {
    assert.deepEqual(collect(forEachViewSourcedSlotsGrid as never), ["legacy-1", "nested-view", "view-1"]);
  });

  test("a grid with no `source` counts as view-sourced, matching the renderer", () => {
    assert.ok(collect(forEachViewSourcedSlotsGrid as never).includes("legacy-1"));
  });

  test("nesting does not hide one", () => {
    assert.ok(collect(forEachViewSourcedSlotsGrid as never).includes("nested-view"));
  });

  test("the two walks never claim the same object", () => {
    const a = new Set(collect(forEachInlineSlotsGrid as never));
    for (const id of collect(forEachViewSourcedSlotsGrid as never)) {
      assert.ok(!a.has(id), `${id} would be resolved twice, and the second write wins silently`);
    }
  });

  test("the source view is reported, or its slots cannot be found", () => {
    const pairs: string[] = [];
    forEachViewSourcedSlotsGrid(views, (id, src) => pairs.push(`${id}->${src}`));
    assert.deepEqual(pairs.sort(), ["legacy-1->slots-b", "nested-view->slots-c", "view-1->slots-a"]);
  });
});

describe("the controller wires both to the whole image", () => {
  // Without this, either walk can be dropped from recomputeResolved and every
  // test above stays green while the photos go back to being column-cropped.
  test("resolves view-sourced grids by object id, with \"whole\"", () => {
    const src = readFileSync(new URL("./stage-controller.ts", import.meta.url), "utf8");
    const call = /forEachViewSourcedSlotsGrid\(([\s\S]*?)\n {4}\}\);/.exec(src);
    assert.ok(call, "view-sourced grids are not resolved at all");
    assert.match(call[1], /slotsByLayoutObject\[oid\]/, "not keyed by object, so it cannot differ from the display");
    assert.match(call[1], /"whole"/, "view-sourced grids are still cropped to a guessed shape");
  });

  test("and the display keeps its column crop", () => {
    const src = readFileSync(new URL("./stage-controller.ts", import.meta.url), "utf8");
    const call = /slotsByView\[view\.id\] = resolveSlots\(([^;]*)\)/.exec(src);
    assert.ok(call, "could not find the view slots resolution");
    assert.doesNotMatch(call[1], /"whole"/, "a display should keep its byte saving");
  });
});
