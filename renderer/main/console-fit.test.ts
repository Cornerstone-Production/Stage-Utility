import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { fitFor } from "./console-fit.js";

// A wall screen has a known aspect, so honour the design exactly. A console is
// on whatever window the operator has, so it responds. An explicit setting
// always wins over both, because a default must not override a choice.

const consoleView = { surface: "console" } as View;
const displayView = { surface: "display" } as View;
const legacyView = {} as View;

describe("fitFor", () => {
  test("a console responds by default", () => {
    // Pillar-boxing a 16:9 design into a laptop window wastes most of it.
    assert.equal(fitFor(consoleView, undefined), "responsive");
  });

  test("a display letterboxes by default", () => {
    assert.equal(fitFor(displayView, undefined), "contain");
  });

  test("a view with no surface letterboxes", () => {
    // Absent means display. Every existing layout must keep its exact look.
    assert.equal(fitFor(legacyView, undefined), "contain");
  });

  test("an explicit setting always wins", () => {
    assert.equal(fitFor(consoleView, "contain"), "contain");
    assert.equal(fitFor(displayView, "responsive"), "responsive");
  });

  test('the old "fill" reads as responsive', () => {
    // Nothing in a real config used it, but a stored value must still parse
    // rather than falling through to the wrong default.
    assert.equal(fitFor(displayView, "fill"), "responsive");
    assert.equal(fitFor(consoleView, "fill"), "responsive");
  });
});
