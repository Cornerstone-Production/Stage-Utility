// Home's cards must never inherit their text colour.
//
// They render in two places with opposite grounds: a themed app page, and Home's
// kiosk surface, which is near-black in BOTH themes. A span with no colour class
// inherits — which happened to look right on the page and came out black on
// black on the grid. Measured at 1.06:1, twice, on two different spans: the live
// timer and the stat values.
//
// So this reads the source and requires every text-scale class in the file to
// name a colour alongside it. It matches on the class attribute, which prose in
// a comment cannot satisfy, and it fails on the exact defect: delete a `text-fg`
// and this goes red.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./cards.tsx", import.meta.url), "utf8");

/** Type-scale classes. Anything carrying one is rendering words. */
const SCALE = /text-(large-title|title[1-3]|headline|subheadline|body|callout|footnote|caption[12])\b/;
/** Anything that names a colour — a token, a semantic scale, or the accent. */
const COLOUR = /text-(fg|fg-muted|fg-subtle|fg-faint|accent|danger-\d+|live-\d+|ok-\d+|warn-\d+|white)\b/;

/** Every className string in the file, including the ones inside cn(). */
function classAttrs(): string[] {
  return [...SRC.matchAll(/className=(?:"([^"]*)"|\{cn\(([\s\S]*?)\)\})/g)].map((m) =>
    (m[1] ?? m[2] ?? "").replace(/\s+/g, " "),
  );
}

describe("Home's cards on the kiosk surface", () => {
  test("every text scale is paired with a colour", () => {
    const orphans = classAttrs().filter((c) => SCALE.test(c) && !COLOUR.test(c));
    assert.deepEqual(
      orphans,
      [],
      "a text class with no colour inherits — which is black on Home's kiosk surface",
    );
  });

  test("the live timer and the stat value name theirs explicitly", () => {
    // The two that were actually broken, pinned by name so a refactor that drops
    // one is caught even if the general rule above is loosened later.
    assert.match(SRC, /text-large-title[^"]*text-fg/, "the live timer lost its colour");
    assert.match(SRC, /text-title2[^"]*text-fg/, "the stat value lost its colour");
  });

  test("the check finds real class attributes, not nothing", () => {
    // A regex that matched no attributes would pass the first test vacuously.
    const attrs = classAttrs();
    assert.ok(attrs.length > 15, `only found ${attrs.length} className attributes`);
    assert.ok(attrs.some((c) => SCALE.test(c)), "found no text-scale classes at all");
  });
});
