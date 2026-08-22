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
const READOUT = readFileSync(new URL("../../main/readout.tsx", import.meta.url), "utf8");

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

  test("the live timer goes through the shared composition", () => {
    // One of the two spans that were actually broken. It no longer names a
    // colour because it no longer names anything: it drew its own markup — a
    // clamp()'d value with the label beside it — and now renders through Stat,
    // which is Readout. The colour guarantee moved with it, to the test below.
    //
    // Pinned so the card cannot quietly go back to hand-rolled markup, which is
    // where the black-on-black came from in the first place.
    // Bounded to the function's OWN body. A `[\s\S]*?<Stat` from the function
    // name would happily cross into the next card and match its Stat — the first
    // version of this test did exactly that and passed while the timer was back
    // to a hand-rolled span.
    const start = SRC.indexOf("export function LiveStatusCard(");
    assert.notEqual(start, -1, "LiveStatusCard not found — was it renamed?");
    const rest = SRC.slice(start + 1);
    const end = rest.search(/\nexport (?:function|const) /);
    const body = end === -1 ? rest : rest.slice(0, end);
    assert.match(body, /<Stat\b/, "the live timer draws its own markup again instead of using Stat");
  });

  test("the stat value takes its colour from a token, not from inheritance", () => {
    // Where BOTH originally-broken spans ended up. Neither is a Tailwind class
    // any more: Stat renders through the shared Readout, and the live timer
    // renders through Stat, so this one assertion covers both.
    //
    // A token rather than a literal white is what makes one component correct on
    // both grounds — inside .kiosk-surface (every display, and Home's widget
    // grid) --color-fg IS white, and on a themed page it is the theme's
    // foreground. A literal would be invisible on the second.
    // The value may now start from the OBJECT's own colour — a custom property
    // the object sets on itself, so the inspector's Color control reaches a
    // readout at all — but the chain still has to end in a token. Written as two
    // assertions rather than one long regex: the second is the one that matters,
    // and it fails on "inherit", on a bare literal, and on dropping the fallback.
    assert.match(READOUT, /color: filled \? "#ffffff" : valueColor \?\?/,
      "the readout's value no longer starts from the filled/valueColor pair");
    assert.match(READOUT, /valueColor \?\? "var\((?:--readout-value-color, )?var\(--color-fg\)\)"/,
      "the readout's value no longer resolves its colour from a token");
    // The unfilled caption and sub too — those are the lines that would go
    // black-on-black, since the value usually carries a state colour.
    assert.match(READOUT, /color: filled \? "rgba\(255,255,255,0\.85\)" : "var\(--color-fg-muted\)"/,
      "the readout's caption no longer resolves its colour from a token");
    assert.match(READOUT, /color: filled \? "rgba\(255,255,255,0\.80\)" : "var\(--color-fg-subtle\)"/,
      "the readout's sub-line no longer resolves its colour from a token");
  });

  test("the check finds real class attributes, not nothing", () => {
    // A regex that matched no attributes would pass the first test vacuously.
    const attrs = classAttrs();
    assert.ok(attrs.length > 15, `only found ${attrs.length} className attributes`);
    assert.ok(attrs.some((c) => SCALE.test(c)), "found no text-scale classes at all");
  });
});
