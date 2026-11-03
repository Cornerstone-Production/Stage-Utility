// What the slot card's inline styles SAY, read off server-rendered markup.
//
// jsdom's CSSStyleDeclaration drops any value it does not parse (a `cqb` unit, a
// `var()` inside `max()`), so a style asserted through a jsdom node can pass because
// the value never arrived. renderToStaticMarkup writes the style string React was
// given, verbatim, so these read the real thing.
//
// What this CANNOT see: how any of it is laid out. jsdom loads no stylesheet and
// resolves no container-query unit, so sizes, placement and paint were checked in a
// real browser and are not asserted here.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

const { SlotPanel } = await import("./slot-panel.js");

function slot(over: Partial<Slot> = {}): Slot {
  return {
    id: "s1",
    channel: "07",
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
    displayName: "Jordan Example",
    photoUrl: null,
    prep: { capsule: "KSM9", ownIems: true },
    device: { status: "ok", rf: 4, battery: 88, freq: "574.000", audioLevel: null, charge: 88, iemCharge: 70, label: null, iemLabel: "IEM 1" },
    ...over,
  } as unknown as Slot;
}

const markup = (over: Partial<Slot> = {}, overlay = false) => renderToStaticMarkup(<SlotPanel slot={slot(over)} overlay={overlay} />);

/** The opening tag of the first element whose tag text contains `needle`. */
function tagWith(html: string, needle: string): string {
  const at = html.indexOf(needle);
  assert.ok(at >= 0, `no element carries ${needle}`);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

describe("the name", () => {
  test("reserves no em-based minimum height", () => {
    // Beta's name carried `minHeight: overlay ? undefined : "min(2.5em, 16cqb)"`,
    // a two-line reservation that moved the position line away from a one-line
    // name. A regex over the SOURCE stayed green for that exact line; this reads
    // the style the card is actually rendered with, in both variants.
    for (const overlay of [false, true]) {
      const name = tagWith(markup({}, overlay), "line-clamp-2");
      assert.doesNotMatch(name, /min-height\s*:[^;"]*em/i, `overlay=${overlay}: ${name}`);
    }
  });

  test("a long name still wraps to two lines, not one clipped one", () => {
    assert.match(tagWith(markup(), "line-clamp-2"), /^<span /);
  });
});

// Every colour literal in a style attribute, as [r, g, b].
function colours(html: string): { text: string; rgb: number[] }[] {
  const out: { text: string; rgb: number[] }[] = [];
  for (const m of html.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) {
    if (m[1]) {
      const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
      out.push({ text: m[0], rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) });
    } else {
      out.push({ text: m[0], rgb: [Number(m[2]), Number(m[3]), Number(m[4])] });
    }
  }
  return out;
}

describe("neutral colours", () => {
  test("every colour the card paints is R=G=B, so no dark is blue-biased", () => {
    // The kiosk is always dark and a blue-biased dark bands on the Pi panels. The
    // card, its band, the scrim and every badge are literals in inline styles.
    for (const overlay of [false, true]) {
      const found = colours(markup({}, overlay));
      assert.ok(found.length >= 6, `expected the card's colours, found ${found.length}`);
      for (const { text, rgb } of found) {
        assert.ok(rgb[0] === rgb[1] && rgb[1] === rgb[2], `overlay=${overlay}: ${text} is not neutral`);
      }
    }
  });

  test("the ears icon is neutral, not just its badge", () => {
    const html = markup({ prep: { capsule: null, ownIems: true } });
    const start = html.indexOf('data-slot-badge="ears"');
    const svg = html.slice(html.indexOf("<svg", start), html.indexOf("</svg>", start));
    const tag = svg.slice(0, svg.indexOf(">"));
    // Only the colour property: the icon's size is calc(var(--px) ...) on purpose.
    const value = /(?:^|[;" ])color\s*:\s*([^;"]+)/.exec(tag)?.[1] ?? "";
    assert.doesNotMatch(value, /var\(|accent/, `the icon takes the brand accent: ${tag}`);
    const found = colours(value);
    assert.equal(found.length, 1, `the ears icon must set a literal neutral colour: ${tag}`);
    assert.ok(found[0].rgb[0] === found[0].rgb[1] && found[0].rgb[1] === found[0].rgb[2], `${found[0].text} is not neutral`);
  });
});

describe("badge boxes keep the floor the text has", () => {
  test("the channel badge and the capsule plate are not pure cqmin", () => {
    // Text is max(0.6rem, ...), so on a very small cell it stops shrinking. A box
    // that keeps shrinking then lets the text overflow it.
    const html = markup();
    for (const kind of ["channel", "capsule"]) {
      const tag = tagWith(html, `data-slot-badge="${kind}"`);
      assert.match(tag, /(?:^|[; "])height\s*:\s*max\(\d+(?:\.\d+)?rem\s*,/, `${kind} height has no rem floor: ${tag}`);
    }
    const channel = tagWith(html, 'data-slot-badge="channel"');
    assert.match(channel, /min-width\s*:\s*max\(\d+(?:\.\d+)?rem\s*,/, `channel min-width has no rem floor: ${channel}`);
  });
});
