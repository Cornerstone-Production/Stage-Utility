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
//
// ONE screen's role is no longer two writes from here: it is one call to the
// role route, and the server orders its own writes (setOutputRole's
// inGuardOrder, driven against the real guards in
// main/services/screen-create-role.test.ts). What is left here is the view
// card's convert-every-screen path, which still makes the writes itself.

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

describe("the view card's handler", () => {
  test("decides from the cache at CALL TIME, not a snapshot the hook closed over", () => {
    // NOT a claim that it re-reads between its writes — it does not. What it
    // catches is the real regression: replacing stateNow() with a value
    // destructured in the hook body, which is stale by the time a click arrives
    // and would pick the wrong screens to move.
    assert.match(SETTINGS_SRC, /const stateNow = \(\) => queryClient\.getQueryData<StageState>/);
    assert.match(handlerBody("handleSetViewSurface"), /stateNow\(\)/, "handleSetViewSurface works from a stale snapshot");
  });
});
