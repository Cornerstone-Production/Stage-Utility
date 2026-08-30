// A view that embeds itself must draw a notice, not recurse until the tab dies.
//
// This replaces the old guard, which was "custom views are not offered in the
// picker". That was correct and free — a custom view is the only kind holding a
// layout, so refusing it meant an embed could never reach another embed. It also
// made a producer multiview impossible, which is what this feature is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_EMBED_DEPTH, childChain, embedRefusal } from "./embed-chain.js";

describe("a view may not contain itself", () => {
  it("allows a view nothing above it is already showing", () => {
    assert.equal(embedRefusal("v-b", ["v-a"]), null);
  });

  it("refuses a view that IS its own parent", () => {
    const r = embedRefusal("v-a", ["v-a"]);
    assert.equal(r?.reason, "cycle");
  });

  it("refuses a view further up the chain, not only the immediate parent", () => {
    // A -> B, and A again. Checking only the immediate parent looks at "v-b",
    // misses it, and lets the render loop for ever.
    //
    // The chain is deliberately SHORTER than MAX_EMBED_DEPTH. At exactly the cap
    // the depth guard fires on this fixture too, so a parent-only regression
    // returns a depth refusal instead of nothing — the test still failed, but on
    // a coincidence rather than on the cycle it names.
    const r = embedRefusal("v-a", ["v-a", "v-b"]);
    assert.equal(r?.reason, "cycle");
  });

  it("says which view, so the notice can name it", () => {
    const r = embedRefusal("v-a", ["v-a"]);
    assert.match(r?.message ?? "", /already/i);
  });
});

describe("nesting is bounded even when it is legal", () => {
  it("allows nesting up to the cap", () => {
    const chain = Array.from({ length: MAX_EMBED_DEPTH - 1 }, (_, i) => `v-${i}`);
    assert.equal(embedRefusal("v-new", chain), null);
  });

  it("refuses past the cap", () => {
    // Four tiles of four tiles of four tiles is 64 live layouts on a Pi. No
    // cycle, and still not something to render.
    const chain = Array.from({ length: MAX_EMBED_DEPTH }, (_, i) => `v-${i}`);
    assert.equal(embedRefusal("v-new", chain)?.reason, "depth");
  });

  it("caps at a number somebody chose", () => {
    assert.equal(MAX_EMBED_DEPTH, 3);
  });
});

describe("the chain handed to a child", () => {
  it("appends this view", () => {
    assert.deepEqual(childChain("v-b", ["v-a"]), ["v-a", "v-b"]);
  });

  it("does not mutate the parent's chain", () => {
    const parent = ["v-a"];
    childChain("v-b", parent);
    assert.deepEqual(parent, ["v-a"], "the parent's chain was mutated — siblings would see each other");
  });
});
