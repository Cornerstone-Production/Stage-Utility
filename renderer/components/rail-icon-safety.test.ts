// The console rail is made of <button> rows, and that constrains what its icon
// can be.
//
// The first cut put the Screens cards' control — a colour swatch, which is a
// <button> — inside one. Nested buttons are invalid, the outer one takes the
// click, and the page navigated every time an icon was touched. Reported as the
// page refreshing on a colour change.
//
// Then the menu itself navigated: it portals to the body, but REACT sends events
// up the REACT tree, so a click inside it still reached the rail row it was
// rendered from and selected that console.
//
// Both are properties of the markup rather than of any render, so both are read
// off the source. What a browser confirmed once cannot be re-confirmed in a unit
// test, but what must never come back can be.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const RAIL = readFileSync(new URL("../app/rail.tsx", import.meta.url), "utf8");
const ICON = readFileSync(new URL("./console-rail-icon.tsx", import.meta.url), "utf8");
const MENU = readFileSync(new URL("./icon-menu.tsx", import.meta.url), "utf8");

describe("the console rail's icon", () => {
  test("is the plain rail icon, not the Screens cards' colour control", () => {
    // IconTint renders a ColorField, which is a <button>. Inside a rail row that
    // is a button in a button.
    assert.doesNotMatch(RAIL, /<IconTint/, "the rail is rendering the colour control again");
    assert.match(RAIL, /<ConsoleRailIcon/);
  });

  test("renders no interactive element of its own", () => {
    // The whole rule, stated once: nothing in here may be focusable, because all
    // of it lands inside the row's <button>.
    assert.doesNotMatch(ICON.split("return (")[1] ?? "", /<button|<a\s|<input/, "an interactive element is back inside the row");
  });

  test("wears the operator's colour ONLY while it is the current page", () => {
    // This used to assert no colour at all, and it was right then: an
    // unconditional tint gave a column of coloured icons and took away the one
    // thing the rail says by colour, which is where you are.
    //
    // Selected is different — the row is already the accent there, so the icon's
    // own colour says the same thing in the operator's terms. The rule is the
    // CONDITION, so this pins that rather than the absence.
    assert.match(ICON, /const colour = active \? state\?\.iconColors\?\.\[viewId\] : undefined;/);
    assert.match(ICON, /style: colour \? \{ color: colour \} : undefined/);
  });

  test("and falls through to the row's own styling when none is set", () => {
    // `undefined`, not a computed default: an inactive row, or a console the
    // operator never coloured, has to inherit exactly what every other tab does.
    assert.match(ICON, /: undefined/);
    assert.doesNotMatch(ICON, /color:\s*(DEFAULT_TINT|"var\()/, "a fallback colour here overrides the row");
  });

  test("opens on the GLYPH, not on the row", () => {
    // A right-click anywhere on the row would fire while aiming at the label.
    assert.match(ICON, /onContextMenu=/);
    assert.doesNotMatch(RAIL, /onContextMenu=/, "the rail row itself answers right-clicks");
  });
});

describe("the icon menu", () => {
  test("stops its own clicks reaching the React ancestor", () => {
    // A portal is not an escape from bubbling.
    assert.match(MENU, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    assert.match(MENU, /onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/);
  });

  test("renders into the body, not into the row", () => {
    assert.match(MENU, /createPortal\(/);
    assert.match(MENU, /document\.body/);
  });
});

describe("the grid's own icons", () => {
  const GRID = readFileSync(new URL("./icon-grid.tsx", import.meta.url), "utf8");

  test("take the theme accent, not the colour being edited", () => {
    // Tinting each cell to the draft made the grid a different colour on every
    // card and matched nothing else in the chrome.
    assert.match(GRID, /className="size-4 text-accent"/);
    assert.doesNotMatch(GRID, /style=\{\{\s*color:\s*tint/);
  });
});
