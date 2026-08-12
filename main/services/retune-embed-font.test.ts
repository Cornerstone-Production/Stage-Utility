// Retuning embedded views off the old default font size.
//
// Changing a palette default only helps objects placed afterwards: the value is
// written INTO the object when it is placed, so `style.fontSize ?? DEFAULT` never
// falls through for anything already saved. The first attempt at this fix changed
// the default alone and was reported as done, while every existing embed on every
// existing display carried on rendering at nearly double the ScriptView page.
//
// The risk on the other side is worse than the bug: this edits an operator's
// saved layouts on load. So it may only ever touch an EXACT match on the old
// default, and it must be idempotent, because it runs on every single start.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { retuneEmbedFontSize } from "./stage-controller.js";

const embed = (fontSize: number | undefined, id = "e1"): LayoutObject => ({
  id, x: 0, y: 0.5, w: 1, h: 0.5, z: 1,
  config: { type: "view-embed", viewId: "v-script" },
  style: fontSize === undefined ? {} : { fontSize },
} as LayoutObject);

const view = (objects: LayoutObject[], id = "view-1"): View => ({
  id, name: "A view", kind: "custom", ndiSource: null, createdAt: "2026-01-01T00:00:00.000Z",
  layout: { version: 1, canvas: { width: 1920, height: 1080, background: "#000", fit: "fill" }, objects },
} as View);

describe("retuneEmbedFontSize", () => {
  it("rewrites an embed still on the old default", () => {
    const { views, changed } = retuneEmbedFontSize([view([embed(0.03)])]);
    assert.equal(changed, 1);
    assert.equal(views[0].layout!.objects[0].style!.fontSize, 0.016);
  });

  it("leaves a size somebody chose completely alone", () => {
    // The core safety property. A display deliberately set large for a big room
    // must stay large — this is the operator's work, not ours to tidy.
    for (const chosen of [0.02, 0.025, 0.029, 0.031, 0.05, 0.08, 0.016]) {
      const { views, changed } = retuneEmbedFontSize([view([embed(chosen)])]);
      assert.equal(changed, 0, `${chosen} should not have been touched`);
      assert.equal(views[0].layout!.objects[0].style!.fontSize, chosen);
    }
  });

  it("is idempotent — it runs on every load", () => {
    const first = retuneEmbedFontSize([view([embed(0.03)])]);
    assert.equal(first.changed, 1);
    const second = retuneEmbedFontSize(first.views);
    assert.equal(second.changed, 0, "a second pass must be a no-op");
    // And returns the same objects, so nothing is needlessly rewritten to disk.
    assert.equal(second.views[0], first.views[0]);
  });

  it("does not touch other object types that happen to sit at 0.03", () => {
    const text = { ...embed(0.03, "t1"), config: { type: "text", text: "hi" } } as LayoutObject;
    const { views, changed } = retuneEmbedFontSize([view([text])]);
    assert.equal(changed, 0);
    assert.equal(views[0].layout!.objects[0].style!.fontSize, 0.03);
  });

  it("reaches an embed nested inside a container", () => {
    // Containers nest, and an embed inside one is exactly as wrong as a top-level
    // one. A flat pass over `objects` would silently skip every nested layout.
    const container = {
      id: "c1", x: 0, y: 0, w: 1, h: 1, z: 1,
      config: { type: "container" },
      style: {},
      children: [embed(0.03, "inner")],
    } as unknown as LayoutObject;
    const { views, changed } = retuneEmbedFontSize([view([container])]);
    assert.equal(changed, 1, "a nested embed must be retuned");
    assert.equal(views[0].layout!.objects[0].children![0].style!.fontSize, 0.016);
  });

  it("survives views with no layout at all", () => {
    // Slots and script views have no `layout`; so does a custom view never edited.
    const bare = { id: "s1", name: "Slots", kind: "slots", ndiSource: null, createdAt: "x" } as View;
    const { views, changed } = retuneEmbedFontSize([bare, view([], "empty")]);
    assert.equal(changed, 0);
    assert.equal(views.length, 2);
  });

  it("leaves an embed with no explicit size alone (it picks up the default itself)", () => {
    const { changed } = retuneEmbedFontSize([view([embed(undefined)])]);
    assert.equal(changed, 0);
  });
});
