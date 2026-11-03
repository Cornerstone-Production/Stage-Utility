// When a slot card is short, what gives way: name > mic row > IEM row > position
// line > photo. A half-height card with a mic row AND an IEM row used to lose its
// name: the info band was capped at 45cqb, the name block was allowed to shrink
// (min-h-0) so the rows kept their size, and what was left of the name drew as
// clipped slivers.
//
// jsdom resolves no container unit and loads no stylesheet, so the LAYOUT was
// verified in a real browser (name fully visible, rows inside the band, badges
// clear of it, at 1920x1080, 1280x720, a 140x220 cell, a stacked 140x104 cell and
// a 390x844 phone). This file pins the pieces that layout rests on, read off the
// rendered markup and the stylesheet, not off the component's source text.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

const { SlotPanel } = await import("./slot-panel.js");

const slot = {
  id: "s1",
  channel: "07",
  order: 0,
  link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
  displayName: "Jordan Example",
  photoUrl: null,
  shownPositions: ["Vocals"],
  prep: { capsule: "KSM9", ownIems: true },
  device: { status: "ok", rf: 4, battery: 88, freq: "574.000", audioLevel: null, charge: 88, iemCharge: 70, label: null, iemLabel: "IEM 1" },
} as unknown as Slot;

const html = renderToStaticMarkup(<SlotPanel slot={slot} />);
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function tagWith(needle: string): string {
  const at = html.indexOf(needle);
  assert.ok(at >= 0, `no element carries ${needle}`);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}
const classes = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);

/** The declarations of the `@container (max-height: ...)` blocks that name `sel`. */
function containerRulesFor(sel: string): string[] {
  return [...css.matchAll(/@container \(max-height:[^)]*\)\s*\{((?:[^{}]*\{[^{}]*\}\s*)+)\}/g)]
    .flatMap((m) => [...m[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)])
    .filter((r) => r[1].includes(sel))
    .map((r) => r[2].replace(/\s+/g, " ").trim());
}

describe("a short card keeps its name", () => {
  test("the name block cannot shrink under the rows", () => {
    const block = html.slice(html.lastIndexOf("<div", html.indexOf("data-slot-name")), html.indexOf("data-slot-name"));
    const cls = classes(block);
    assert.ok(cls.includes("shrink-0"), `name block: ${block}`);
    assert.ok(!cls.includes("min-h-0"), `name block: ${block}`);
  });

  test("the name keeps line-clamp, which `block` would switch off", () => {
    const cls = classes(tagWith("data-slot-name"));
    assert.ok(cls.includes("line-clamp-2"));
    assert.ok(!cls.includes("block"), "display:block defeats -webkit-box, so a long name never clamped");
  });

  test("the band is content-sized and shrink-0; the photo region is what gives", () => {
    const band = tagWith("z-10 flex flex-col justify-start");
    assert.ok(classes(band).includes("shrink-0"), band);
    assert.match(band, /max-height:\s*100cqb/);
    assert.doesNotMatch(band, /max-height:\s*45cqb/);
    assert.ok(classes(tagWith("relative flex-1 min-h-0")).includes("overflow-hidden"), "the photo region clips its badges");
  });
});

describe("what is dropped as the card gets shorter", () => {
  test("the position line is the first text dropped, and only the position line", () => {
    assert.ok(tagWith("data-slot-position").includes("data-slot-position"));
    const rules = containerRulesFor("[data-slot-position]");
    assert.equal(rules.length, 1, "one container rule hides the position line");
    assert.match(rules[0], /display:\s*none/);
    // The name and both rows are never display:none in any container rule.
    for (const sel of ["[data-slot-name]", "[data-slot-row"]) {
      for (const r of containerRulesFor(sel)) assert.doesNotMatch(r, /display:\s*none/, `${sel} must not vanish`);
    }
  });

  test("a short card holds the name to one line, with an ellipsis", () => {
    const rules = containerRulesFor("[data-slot-name]");
    assert.equal(rules.length, 1);
    assert.match(rules[0], /-webkit-line-clamp:\s*1\b/);
  });

  test("the badges leave a photo too short to hold them", () => {
    assert.ok(html.includes("data-slot-badges"));
    const rules = containerRulesFor("[data-slot-badges]");
    assert.equal(rules.length, 1);
    assert.match(rules[0], /display:\s*none/);
  });

  test("the photo goes before the position line does: badges leave at a taller card", () => {
    const h = (sel: string) => {
      const m = new RegExp(`@container \\(max-height:\\s*([\\d.]+)rem\\)\\s*\\{[^@]*${sel.replace(/[[\]]/g, "\\$&")}`).exec(css);
      assert.ok(m, `no container query for ${sel}`);
      return Number(m[1]);
    };
    assert.ok(h("[data-slot-badges]") > h("[data-slot-position]"));
  });
});
