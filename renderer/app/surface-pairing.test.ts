// A screen's mode and its view's surface are two fields, and only one direction
// was wired.
//
// Assigning a console view to a screen already offered to make that screen a
// control surface. The reverse did nothing: "Use as a control surface" on the
// Screens page set `output.mode = "panel"` and left `view.surface` alone — and
// the rail builds its CONSOLES list from `view.surface`, so the console the
// operator had just made never appeared until they set it a second time in the
// editor. Reported as having to click it in both places.
//
// Source text, because both handlers are closures over a query client inside a
// hook, and what has to hold is that each one writes BOTH fields.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The cut is shared with surface-swap-order.test.ts — see the module for why one
// rule rather than the two that had drifted apart.
import { handlerBody, handlerBodyRaw } from "./settings-handler-source.js";

describe("setting a screen to a control surface", () => {
  const src = handlerBody("handleSetOutputMode");

  test("also sets the view it shows, or the rail never lists it", () => {
    assert.match(src, /views:setSurface/, "the view's surface is never written");
  });

  test("picks the surface from the mode rather than hard-coding one", () => {
    // Both directions: panel -> console, and back to a wall screen again.
    assert.match(src, /"panel"[\s\S]*?"console"[\s\S]*?"display"/);
  });

  test("does nothing further when the first write was refused", () => {
    // writeState answers false on failure. Carrying on would change one half of
    // the pair for a change the server had already rejected.
    assert.match(src, /if \(!\(await writeState\(/);
  });
});

describe("setting a view to a control surface", () => {
  const src = handlerBody("handleSetViewSurface");

  test("also sets every screen showing it, or its buttons render dead", () => {
    assert.match(src, /outputs:setMode/, "the screens' modes are never written");
  });

  test("EVERY screen, not just the first — a view can be on several", () => {
    assert.match(src, /for \(const o of showing\)/);
  });

  test("writes only the screens that actually differ", () => {
    // `showing` is filtered to the ones not already in the wanted mode, so a
    // pairing does not re-write half the wall to no effect.
    assert.match(src, /\(o\.mode \?\? "display"\) !== wantMode/);
  });

  test("does nothing further when the first write was refused", () => {
    assert.match(src, /if \(!\(await writeState\(/);
  });
});

describe("the cut these assertions run over", () => {
  test("THE GUARD: a handler's text stops before the JSDoc of the next one", () => {
    // A source-text assertion satisfied by PROSE is the exact failure CLAUDE.md
    // lists, and this file used to cut at the next `async function` only — so
    // the block comment introducing the NEXT handler was inside this one's
    // "body". The cut was also the ONLY defence: a `//` line inside the handler
    // naming an IPC channel satisfied a match for that channel with the write
    // deleted, which is no longer possible because the text every assertion here
    // reads has its comments blanked.
    //
    // The RAW cut for the boundary, because the blanked one has no comment left
    // to find and the question here is where the cut LANDS.
    const raw = handlerBodyRaw("handleSetOutputMode");
    assert.ok(
      !raw.includes("/**"),
      "the cut swallowed a block comment, so a sentence can satisfy an assertion about code",
    );
    assert.ok(
      !raw.includes("async function handleSetViewSurface"),
      "the cut ran into the next handler entirely",
    );
    const src = handlerBody("handleSetOutputMode");
    assert.doesNotMatch(src, /\/\/|\/\*/, "a comment survived into the text the assertions read");
    // And it did not cut so early that there is nothing left to assert on.
    assert.match(src, /outputs:setMode/);
  });
});
