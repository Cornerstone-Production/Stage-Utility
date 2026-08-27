// Three colour panels could be open at once.
//
// `open` is per-instance state and nothing coordinated the instances, so the
// Screens page — one swatch per display card — opened a panel per click and left
// them all on screen, each anchored to its own trigger and each editing
// something different. Measured in a browser before the fix: clicking three in a
// row left 1, then 2, then 3 panels in the document.
//
// One panel for the icon AND its colour, for the same reason a colour panel is
// one panel: they describe the same object. A preview in the colour being
// dragged, and a button that swaps the body for the icon set.
//
// And the accent flash, which is the same shape one level up: `--brand-accent`
// is ONE variable on the document root, and seventeen components call
// useStageState. Every one starts with a null state, and applyAccentVar(undefined)
// REMOVES the override — so any component mounting mid-session stripped the
// accent off the whole page until its own fetch returned. The panel's saved
// colours list is one of those seventeen, which is why opening a picker flashed
// every accent-coloured thing on the page.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const FIELD = readFileSync(new URL("./color-field.tsx", import.meta.url), "utf8");
const HOOK = readFileSync(new URL("../../main/use-stage-state.ts", import.meta.url), "utf8");

describe("one colour panel at a time", () => {
  test("there is a register of open panels, not just per-instance state", () => {
    assert.match(FIELD, /const closers = new Set<\(\) => void>\(\)/);
  });

  test("opening one closes the others", () => {
    const fn = /function useOnlyOnePanel\([\s\S]*?\n\}/.exec(FIELD);
    assert.ok(fn, "the coordinator is gone");
    assert.match(fn[0], /for \(const other of \[\.\.\.closers\]\) other\(\)/);
  });

  test("it closes the others BEFORE joining, or it closes itself", () => {
    const fn = /function useOnlyOnePanel\([\s\S]*?\n\}/.exec(FIELD)![0];
    assert.ok(
      fn.indexOf("other()") < fn.indexOf("closers.add"),
      "this panel joins the register before closing the rest, so it shuts itself",
    );
  });

  test("and leaves the register on unmount, or a closed panel keeps closing others", () => {
    const fn = /function useOnlyOnePanel\([\s\S]*?\n\}/.exec(FIELD)![0];
    assert.match(fn, /closers\.delete\(close\)/);
  });

  test("the field actually uses it", () => {
    assert.match(FIELD, /useOnlyOnePanel\(open, setOpen\)/);
  });
});

describe("the brand accent", () => {
  test("is not cleared by a component that has not hydrated", () => {
    const eff = /Push the themeable brand accent[\s\S]*?\}, \[[^\]]*\]\);/.exec(HOOK);
    assert.ok(eff, "the accent effect is gone");
    assert.match(eff[0], /if \(!state\) return;/, "an un-hydrated instance still strips the accent");
  });

  test("but a hydrated null accent still clears it — that is a real choice", () => {
    const eff = /Push the themeable brand accent[\s\S]*?\}, \[[^\]]*\]\);/.exec(HOOK)![0];
    assert.match(eff, /applyAccentVar\(state\.accentColor\)/);
  });
});

describe("the icon and its colour are one panel", () => {
  test("the panel can carry an icon, and previews it in the draft colour", () => {
    // The preview follows the DRAFT, not the stored value — a preview showing the
    // colour you just left is worse than none.
    assert.match(FIELD, /icon\?: IconEditing/);
    assert.match(FIELD, /createElement\(icon\.glyph, \{[^}]*swatchCss/s);
  });

  test("a button swaps the body for the set, and back", () => {
    assert.match(FIELD, /setPickingIcon\(\(v\) => !v\)/);
    assert.match(FIELD, /pickingIcon \? "Back to colour" : "Change icon"/);
    assert.match(FIELD, /icon && pickingIcon \? \(\s*<IconGrid/s);
  });

  test("picking one returns to the colour, so the panel does not dead-end", () => {
    assert.match(FIELD, /icon\.onPick\(name\); setPickingIcon\(false\)/);
    assert.match(FIELD, /icon\.onClear\(\); setPickingIcon\(false\)/);
  });

  test("there is no second popup left to open", () => {
    // The standalone picker was deleted with the two-menu flow. A file that came
    // back would mean two ways to change one icon again.
    assert.equal(existsSync(new URL("../icon-picker.tsx", import.meta.url)), false);
  });
});
