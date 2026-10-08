// Which views a screen draws: its own, and what it embeds, to any depth, and a
// loop of embeds ends.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { viewsDrawnBy } from "./screen-reach.js";

const view = (id: string, ...configs: unknown[]): View =>
  ({
    id, name: id, kind: "custom", createdAt: "",
    layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: configs.map((config, i) => ({ id: `${id}-o${i}`, x: 0, y: 0, w: 1, h: 1, z: i, config })) },
  }) as unknown as View;
const out = (id: string, viewId: string | null): Output => ({ id, name: id, viewId }) as Output;

describe("viewsDrawnBy", () => {
  it("is the routed view and nothing else for a layout that embeds nothing", () => {
    assert.deepEqual([...viewsDrawnBy(out("a", "v1"), [view("v1", { type: "clock" }), view("v2")], [])], ["v1"]);
  });

  it("follows view-embed and screen-embed tiles, through more than one level", () => {
    const views = [
      view("top", { type: "view-embed", viewId: "mid" }),
      view("mid", { type: "screen-embed", outputId: "other" }),
      view("deep", { type: "clock" }),
      view("unrelated"),
    ];
    const outputs = [out("main", "top"), out("other", "deep")];
    assert.deepEqual([...viewsDrawnBy(outputs[0], views, outputs)].sort(), ["deep", "mid", "top"]);
  });

  it("ends on a loop, and on a screen routed to nothing or embedding one that is", () => {
    const views = [view("a", { type: "view-embed", viewId: "b" }), view("b", { type: "view-embed", viewId: "a" }, { type: "screen-embed", outputId: "none" }, { type: "screen-embed", outputId: "gone" })];
    const outputs = [out("main", "a"), out("none", null)];
    assert.deepEqual([...viewsDrawnBy(outputs[0], views, outputs)].sort(), ["a", "b"]);
    assert.deepEqual([...viewsDrawnBy(out("empty", null), views, outputs)], []);
  });
});
