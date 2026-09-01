// The strip's items sit on ONE baseline, and the things with no baseline centre.
//
// WHAT THIS CAN AND CANNOT SEE. jsdom lays nothing out, so it cannot measure a
// baseline — the pixel evidence lives in the PR, taken in a real browser:
// centring put the 11px "LIVE" half a pixel above the 13px words either side of
// it, because `items-center` aligns boxes and a centred box's baseline is
// `22 + (ascent - descent) / 2`, a term that moves with the font size.
//
// What IS checkable here is that the rule is applied to the real rendered
// element rather than to a constant somebody could stop using: these assertions
// go through the components, so deleting `items-baseline` from BAR_ITEM_CLASS,
// or handing an item a class of its own that forgets it, both fail.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BAR_ITEM_CLASS } from "./context-bar";

describe("the context bar's items share a baseline", () => {
  it("aligns an item's parts on their baseline, not their boxes", () => {
    assert.ok(
      BAR_ITEM_CLASS.includes("items-baseline"),
      `an item centres its parts (${BAR_ITEM_CLASS}) — a smaller word inside it, like the 11px LIVE, ` +
        "then sits half a pixel off the prose beside it, which is a whole device pixel on a Retina screen",
    );
    assert.ok(
      !BAR_ITEM_CLASS.includes("items-center"),
      "an item cannot be both centred and baseline-aligned; the later class silently wins",
    );
  });
});

describe("the parts with no baseline of their own centre instead", () => {
  // Flex gives a childless box no baseline, so it aligns its BOTTOM MARGIN EDGE
  // to the text baseline — the live dot would sink to sit on the words' feet.
  // Each of these must say `self-center` for itself.
  const SOURCE = new URL("./context-bar.tsx", import.meta.url);

  it("the live dot and the item glyph both opt out", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(SOURCE, "utf8");

    const dot = src.match(/className=\{cn\("size-1\.5[^"]*"/)?.[0] ?? "";
    assert.ok(
      dot.includes("self-center"),
      `the live dot does not centre itself (${dot || "not found"}) — with the item baseline-aligned it drops to sit on the text's feet`,
    );

    const glyph = src.match(/className="bar-glyph[^"]*"/)?.[0] ?? "";
    assert.ok(
      glyph.includes("self-center"),
      `the item glyph does not centre itself (${glyph || "not found"}) — an icon has no baseline and would hang below the word it labels`,
    );
  });
});
