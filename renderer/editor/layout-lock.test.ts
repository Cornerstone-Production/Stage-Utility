import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

// Reaching for one object and catching the edge of another resizes it by
// accident; undo only helps if you noticed.
//
// The property that matters is INERTNESS, not invisibility. Hiding the handles
// while leaving the drag live is the version of this that looks fixed and is
// not — so the assertions are about the gate in the drag path, and the hidden
// handles are checked separately as the second, cosmetic half.

const SRC = readFileSync(new URL("./layout-editor.tsx", import.meta.url), "utf8");

/** The body of startDrag, where "this cannot move" is decided. */
function startDragBody(): string {
  const i = SRC.indexOf("function startDrag(");
  assert.notEqual(i, -1, "startDrag not found - was it renamed?");
  const next = SRC.indexOf("\n  function ", i + 1);
  return SRC.slice(i, next === -1 ? undefined : next);
}

describe("locked means inert, not merely hidden", () => {
  test("startDrag returns early when the canvas is locked", () => {
    assert.match(startDragBody(), /if \(locked\) return;/, "the drag path must refuse to start");
  });

  test("the gate sits beside the per-object lock, not somewhere else", () => {
    // Two places that decide "this cannot move" is how they end up disagreeing.
    const body = startDragBody();
    const canvas = body.indexOf("if (locked) return;");
    const perObject = body.indexOf("isLockedInTree(objects, o.id)");
    assert.ok(canvas !== -1 && perObject !== -1);
    assert.ok(Math.abs(canvas - perObject) < 400, "the two locks must be decided together");
  });

  test("the canvas lock does not replace the per-object padlock", () => {
    // Both survive: one is about the layout, the other about how you are working.
    assert.match(SRC, /isLockedInTree\(objects, o\.id\)/);
  });
});

describe("what stays available while locked", () => {
  test("selection is not gated on the lock", () => {
    // A lock that blocks selection makes the layout unreadable while locked -
    // you could not inspect a widget without unlocking and risking a nudge.
    const body = startDragBody();
    const select = body.indexOf("onSelect(o.id, false)");
    const gate = body.indexOf("if (locked) return;");
    assert.ok(select !== -1 && gate !== -1);
    assert.ok(select < gate, "selection must happen BEFORE the lock gate returns");
  });
});

describe("the handles are hidden too", () => {
  test("resize handles do not render on a locked canvas", () => {
    assert.match(SRC, /\{sel && !locked && !canvasLocked &&/);
  });

  test("the lock reaches nested objects", () => {
    // A child of a container must be as locked as its parent.
    assert.match(SRC, /canvasLocked=\{canvasLocked\}/, "children must inherit the canvas lock");
  });
});

describe("the default", () => {
  test("unlocked, so the first drag does something", () => {
    assert.match(SRC, /const \[layoutLocked, setLayoutLocked\] = useState\(false\)/);
  });
});
