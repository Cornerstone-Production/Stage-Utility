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
    //
    // The `?? ""` used to stand alone, and an empty string matches nothing — so
    // restructuring the component to `return <>` handed this an empty body and
    // the guard passed having checked no markup at all. The body has to be
    // FOUND before it can be cleared.
    const body = ICON.split("return (")[1];
    assert.ok(body, "no `return (` in the component — this guard was reading nothing");
    assert.doesNotMatch(body, /<button|<a\s|<input/, "an interactive element is back inside the row");
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
    //
    // The absence is the whole claim. An `assert.match(ICON, /: undefined/)`
    // used to sit above this line and was satisfied by the `: undefined` the
    // test before it already pins, so it could never fail on its own.
    assert.doesNotMatch(ICON, /color:\s*(DEFAULT_TINT|"var\()/, "a fallback colour here overrides the row");
  });

  test("opens on the GLYPH, and the row's own menu never opens over it", () => {
    // The icon menu is the glyph's. A right-click anywhere else on the row opens
    // the ROW's menu (Hide, Move to, Customize sidebar…), which customizing the
    // sidebar added; before that, the row had no menu and this guard said so.
    // What must hold now is that the two never both open: the glyph's trigger
    // claims the right-click, and the row's trigger leaves a claimed one alone.
    // That is behaviour, so it is driven in app/sidebar-rail.test.tsx ("a
    // right-click on a console's glyph opens its icon menu and not the row's");
    // here, only that the glyph hands its right-click to its own trigger.
    assert.match(ICON, /onContextMenu=\{trigger\.onContextMenu\}/);
    assert.match(
      RAIL,
      /import\s*\{[^}]*\buseContextMenuTrigger\b[^}]*\}\s*from\s*["']\.\.\/components\/ui\/context-menu-trigger["']/,
      "rail.tsx no longer imports useContextMenuTrigger — its menus must ride it, not a raw onContextMenu",
    );
    // Every right-click handler in rail.tsx, by the trigger it hands to: the
    // rail's own menu, the resize handle's one-item menu, and each row's. A
    // sorted list, one per line: a new raw handler, or one of these lost into a
    // spread, changes it. An EXACT list, because a loop over whatever matched
    // once passed having checked nothing.
    const uses = (RAIL.match(/onContextMenu=\{[^}]*\}/g) ?? []).map((u) => /(\w+)\.onContextMenu/.exec(u)?.[1] ?? u);
    assert.deepEqual(uses.sort(), [
      "railTrigger",
      "resizeTrigger",
      "trigger",
    ]);
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
