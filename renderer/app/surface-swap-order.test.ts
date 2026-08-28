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
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SRC = readFileSync(new URL("./use-stage-settings.ts", import.meta.url), "utf8");

function body(name: string): string {
  const i = SRC.indexOf(`async function ${name}(`);
  assert.ok(i >= 0, `${name} is gone — the ordering it carries went with it`);
  const rest = SRC.slice(i + 10);
  const j = rest.indexOf("\n  /**");
  const k = rest.indexOf("\n  async function ");
  const end = [j, k].filter((n) => n > 0).sort((a, b) => a - b)[0];
  return rest.slice(0, end ?? undefined);
}

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
  const src = body("handleSetOutputMode");
  const branch = src.slice(src.indexOf('mode === "display"'));

  test("changes the VIEW first, or the server refuses and nothing moves", () => {
    assert.equal(firstWrite(branch), "view", "the screen is still set first — this deadlocks");
  });

  test("and stops if that write was refused", () => {
    assert.match(branch, /if \(!\(await writeState\("views:setSurface"[\s\S]{0,80}?\)\)\) return;/);
  });
});

describe("making a screen a control surface", () => {
  const src = body("handleSetOutputMode");
  const tail = src.slice(src.lastIndexOf("if (!(await writeState(\"outputs:setMode\""));

  test("changes the SCREEN first — the view cannot lead here", () => {
    // setViewSurface(console) refuses while the screen is still a display.
    assert.equal(firstWrite(tail), "output");
  });
});

describe("turning a view into a control surface", () => {
  const src = body("handleSetViewSurface");
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
  const src = body("handleSetViewSurface");
  const tail = src.slice(src.lastIndexOf('if (!(await writeState("views:setSurface"'));

  test("changes the VIEW first", () => {
    assert.equal(firstWrite(tail), "view");
  });
});

describe("both handlers", () => {
  test("read the state fresh, because the second write must see the first", () => {
    assert.match(SRC, /const stateNow = \(\) => queryClient\.getQueryData<StageState>/);
    for (const fn of ["handleSetOutputMode", "handleSetViewSurface"]) {
      assert.match(body(fn), /stateNow\(\)/, `${fn} works from a stale snapshot`);
    }
  });
});
