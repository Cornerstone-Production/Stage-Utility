// Which views a screen draws: its own, and what it embeds, to any depth, and a
// loop of embeds ends.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_VIEWS_VISITED, viewsDrawnBy } from "./screen-reach.js";

const view = (id: string, ...configs: unknown[]): View =>
  ({
    id, name: id, kind: "custom", createdAt: "",
    layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: configs.map((config, i) => ({ id: `${id}-o${i}`, x: 0, y: 0, w: 1, h: 1, z: i, config })) },
  }) as unknown as View;
/** A view whose one object is a container, with the given configs inside it: the embeds a walk of only the top level misses. */
const inContainer = (id: string, ...configs: unknown[]): View => {
  const v = view(id, { type: "container" });
  v.layout!.objects[0].children = configs.map((config, i) => ({ id: `${id}-c${i}`, x: 0, y: 0, w: 1, h: 1, z: i, config }) as unknown as LayoutObject);
  return v;
};
const out = (id: string, viewId: string | null): Output => ({ id, name: id, viewId }) as Output;

describe("viewsDrawnBy", () => {
  it("is the routed view and nothing else for a layout that embeds nothing", () => {
    assert.deepEqual([...viewsDrawnBy(out("a", "v1"), [view("v1", { type: "clock" }), view("v2")], [])], ["v1"]);
  });

  it("follows view-embed and screen-embed tiles, through more than one level", () => {
    const views = [
      // Both embeds sit inside a container: a walk of only the top level misses them.
      inContainer("top", { type: "view-embed", viewId: "mid" }),
      inContainer("mid", { type: "screen-embed", outputId: "other" }),
      view("deep", { type: "clock" }),
      view("unrelated"),
    ];
    const outputs = [out("main", "top"), out("other", "deep")];
    assert.deepEqual([...viewsDrawnBy(outputs[0], views, outputs)].sort(), ["deep", "mid", "top"]);
  });

  it("ends on a loop, and on a screen routed to nothing or embedding one that is", () => {
    const views = [view("a", { type: "view-embed", viewId: "b" }), view("b", { type: "view-embed", viewId: "a" }, { type: "screen-embed", outputId: "none" }, { type: "screen-embed", outputId: "gone" })];
    const outputs = [out("main", "a"), out("none", null)];
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      assert.deepEqual([...viewsDrawnBy(outputs[0], views, outputs)].sort(), ["a", "b"]);
      assert.deepEqual([...viewsDrawnBy(out("empty", null), views, outputs)], []);
    } finally {
      console.warn = warn;
    }
    // A loop is cut by the seen set, not by running into the cap.
    assert.deepEqual(lines, [], "the loop ran until the hard cap");
  });

  it("stops at a hard cap and says so, so a runaway fails with a message rather than at the job timeout", () => {
    // 300 distinct views, each embedding the next: no loop for the seen set to cut.
    const views = Array.from({ length: 300 }, (_, i) => view(`v${i}`, { type: "view-embed", viewId: `v${i + 1}` }));
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const reached = viewsDrawnBy(out("main", "v0"), views, []);
      assert.equal(reached.size, MAX_VIEWS_VISITED, "the walk did not stop at the cap");
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(lines, [`[messages] the views screen main draws run past ${MAX_VIEWS_VISITED}; stopped looking for the widget there`]);
  });
});
