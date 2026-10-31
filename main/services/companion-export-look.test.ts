// What the picker draws of a Companion export: colours, icons, references and
// the extent of a page.
//
// Every case runs the real parsers over the synthetic fixture, whose shapes were
// read off a real Companion 5 export (see fixtures/companion-export.ts): a box
// layer's `color` is the background and a text layer's `color` the text, both
// 24-bit RGB integers; an icon is the image layer's `base64Image.value`; a
// `button-reference` carries only `options.location`; every page declares an
// 18 by 8 `gridSize` whatever it uses.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseButtons, parsePages } from "./companion-export.js";
import { FIXTURE_ICON, FIXTURE_PAGES, companionExportFixture } from "./fixtures/companion-export.js";

const buttons = parseButtons(companionExportFixture());
const { summaries, views } = parsePages(companionExportFixture());
const byLabel = (label: string, page: number) => buttons.find((b) => b.label === label && b.page === page)!;
const viewOf = (n: number) => views.find((v) => v.page === n)!;
const keyAt = (page: number, row: number, col: number) =>
  viewOf(page).keys.find((k) => k.row === row && k.col === col)!;

describe("a button's colours", () => {
  test("the box layer is the background and the text layer the text, as CSS hex", () => {
    const on = byLabel("Projectors ON", 1);
    assert.equal(on.bg, "#2e6691");
    assert.equal(on.fg, "#f4f0ec");
  });

  test("a button with no colours of its own reads the chrome's: black ground, white text", () => {
    const off = byLabel("Projectors OFF", 1);
    assert.equal(off.bg, "#000000");
    assert.equal(off.fg, "#ffffff");
  });

  test("a background that is an expression is null, not a colour", () => {
    assert.equal(byLabel("House Lights ON", 1).bg, null);
  });
});

describe("the page list", () => {
  test("every page with its name and how many labelled buttons it has", () => {
    assert.deepEqual(
      summaries.map((p) => `${p.page}|${p.name}|${p.labelled}`),
      [
        `1|${FIXTURE_PAGES.screens}|6`,
        `2|${FIXTURE_PAGES.lights}|6`,
        `3|${FIXTURE_PAGES.cameras}|6`,
        "4|PAGE|0",
        `5|${FIXTURE_PAGES.recorders}|11`,
      ],
    );
  });
});

describe("one page as the picker draws it", () => {
  test("an icon is the image layer's data URI, and a built-in image name is not an icon", () => {
    assert.equal(keyAt(1, 0, 1).icon, FIXTURE_ICON);
    assert.equal(keyAt(1, 2, 3).label, "Take Screens");
    assert.equal(keyAt(1, 2, 3).icon, null);
  });

  test("a key carries its own colours", () => {
    const k = keyAt(1, 0, 1);
    assert.deepEqual([k.kind, k.label, k.bg, k.fg, k.pickable], ["button", "Projectors ON", "#2e6691", "#f4f0ec", true]);
  });

  test("a reference draws as the key it points at, marked, and a press goes to that key", () => {
    const ref = keyAt(3, 5, 11);
    assert.equal(ref.kind, "reference");
    assert.equal(ref.label, "Projectors ON");
    assert.equal(ref.bg, "#2e6691");
    assert.equal(ref.icon, FIXTURE_ICON);
    assert.deepEqual(ref.target, { page: 1, row: 0, col: 1 });
    assert.equal(ref.pickable, true);
  });

  test("a reference to nothing is a blank key that cannot be picked", () => {
    const ref = keyAt(3, 5, 12);
    assert.deepEqual([ref.kind, ref.label, ref.pickable], ["reference", "", false]);
    assert.deepEqual(ref.target, { page: 99, row: 0, col: 0 });
  });

  test("page furniture is blank and cannot be picked", () => {
    const controls = viewOf(1).keys.filter((k) => k.kind === "page-control");
    assert.deepEqual(
      controls.map((k) => `${k.row}/${k.col}|${k.label}|${k.pickable}`),
      ["7/0||false", "7/1||false", "7/2||false"],
    );
  });

  test("a button with actions and no label is pickable, and draws blank", () => {
    assert.equal(keyAt(1, 3, 0).pickable, true);
    assert.equal(keyAt(1, 3, 0).label, "");
  });

  test("references and furniture are not buttons: the button list is unchanged by them", () => {
    assert.equal(buttons.length, 30);
    assert.ok(!buttons.some((b) => b.page === 3 && b.row === 5));
  });
});

describe("a page's extent", () => {
  /** A document with one page holding only the given controls. */
  const doc = (controls: Record<string, Record<string, unknown>>) => ({
    pages: { "1": { name: "P", controls, gridSize: { minColumn: 0, maxColumn: 17, minRow: 0, maxRow: 7 } } },
  });
  const btn = { type: "button-layered", style: { layers: [{ type: "text", text: { value: "X", isExpression: false } }] } };

  test("is at least 8 columns by 4 rows however little is used", () => {
    const v = parsePages(doc({ "0": { "0": btn } })).views[0]!;
    assert.deepEqual([v.cols, v.rows], [8, 4]);
  });

  test("grows to what is used, not to the declared grid", () => {
    const v = parsePages(doc({ "0": { "0": btn }, "5": { "11": btn } })).views[0]!;
    assert.deepEqual([v.cols, v.rows], [12, 6]);
  });

  test("a page with no controls at all is still 8 by 4", () => {
    const v = parsePages({ pages: { "1": { name: "Empty" } } }).views[0]!;
    assert.deepEqual([v.cols, v.rows, v.keys.length], [8, 4, 0]);
  });

  test("the fixture's wide page", () => {
    const v = viewOf(3);
    assert.deepEqual([v.cols, v.rows], [13, 8]);
  });
});
