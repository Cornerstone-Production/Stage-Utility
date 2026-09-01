// Two guards that each wait for the other side to move first.
//
//   setOutputMode(display)   refuses while the view it shows is a console
//   setViewSurface(console)  refuses while a screen showing it is not a panel
//
// Pairing the two writes without minding the order deadlocks one direction:
// "Use as a display" set the screen first, the server correctly refused because
// the screen was still showing a control surface, and the handler stopped —
// leaving no sequence of clicks that could get out of it. Reported as an error
// on trying to turn a control surface back into a display.
//
// The rule is one line: whichever side is being made MORE permissive goes first.
// Becoming a control surface, the screen leads. Becoming a wall screen, the view
// does.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The cut is shared with surface-pairing.test.ts — see the module for why one
// rule rather than the two that had drifted apart.
import { handlerBody, SETTINGS_SRC } from "./settings-handler-source.js";

/** Which write appears first in a branch of the source. */
function firstWrite(src: string): "view" | "output" | null {
  const v = src.indexOf("views:setSurface");
  const o = src.indexOf("outputs:setMode");
  if (v < 0 && o < 0) return null;
  if (v < 0) return "output";
  if (o < 0) return "view";
  return v < o ? "view" : "output";
}

describe("turning a screen back into a display", () => {
  const src = handlerBody("handleSetOutputMode");
  const branch = src.slice(src.indexOf('mode === "display"'));

  test("changes the VIEW first, or the server refuses and nothing moves", () => {
    assert.equal(firstWrite(branch), "view", "the screen is still set first — this deadlocks");
  });

  test("and stops if that write was refused", () => {
    assert.match(branch, /if \(!\(await writeState\("views:setSurface"[\s\S]{0,80}?\)\)\) return;/);
  });
});

describe("making a screen a control surface", () => {
  const src = handlerBody("handleSetOutputMode");
  const tail = src.slice(src.lastIndexOf("if (!(await writeState(\"outputs:setMode\""));

  test("changes the SCREEN first — the view cannot lead here", () => {
    // setViewSurface(console) refuses while the screen is still a display.
    assert.equal(firstWrite(tail), "output");
  });
});

describe("turning a view into a control surface", () => {
  const src = handlerBody("handleSetViewSurface");
  const branch = src.slice(src.indexOf('surface === "console"'));

  test("changes the SCREENS first, all of them", () => {
    assert.equal(firstWrite(branch), "output");
    assert.match(branch, /for \(const o of showing\)/);
  });

  test("and abandons the view change if a screen refused", () => {
    assert.match(branch, /if \(!\(await writeState\("outputs:setMode"[\s\S]{0,90}?\)\)\) return;/);
  });
});

describe("turning a view back into a wall screen", () => {
  const src = handlerBody("handleSetViewSurface");
  const tail = src.slice(src.lastIndexOf('if (!(await writeState("views:setSurface"'));

  test("changes the VIEW first", () => {
    assert.equal(firstWrite(tail), "view");
  });
});

describe("both handlers", () => {
  test("decide from the cache at CALL TIME, not a snapshot the hook closed over", () => {
    // NOT a claim that either handler re-reads between its two writes — neither
    // does, and the name this test used to carry said it did. What it catches is
    // the real regression: replacing stateNow() with a value destructured in the
    // hook body, which is stale by the time a click arrives and would pick the
    // wrong side to move first.
    assert.match(SETTINGS_SRC, /const stateNow = \(\) => queryClient\.getQueryData<StageState>/);
    for (const fn of ["handleSetOutputMode", "handleSetViewSurface"]) {
      assert.match(handlerBody(fn), /stateNow\(\)/, `${fn} works from a stale snapshot`);
    }
  });
});
