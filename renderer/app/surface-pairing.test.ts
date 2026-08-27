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
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SRC = readFileSync(new URL("./use-stage-settings.ts", import.meta.url), "utf8");

function body(name: string): string {
  const i = SRC.indexOf(`async function ${name}(`);
  assert.ok(i >= 0, `${name} is gone — the pairing it carries went with it`);
  // To the start of the next top-level handler.
  const rest = SRC.slice(i + 10);
  const j = rest.indexOf("\n  async function ");
  return rest.slice(0, j === -1 ? undefined : j);
}

describe("setting a screen to a control surface", () => {
  const src = body("handleSetOutputMode");

  test("also sets the view it shows, or the rail never lists it", () => {
    assert.match(src, /views:setSurface/, "the view's surface is never written");
  });

  test("picks the surface from the mode rather than hard-coding one", () => {
    // Both directions: panel -> console, and back to a wall screen again.
    assert.match(src, /"panel"[\s\S]*?"console"[\s\S]*?"display"/);
  });

  test("does nothing further when the first write was refused", () => {
    // writeTo answers null on failure. Carrying on would set a view's surface
    // for a screen whose mode never actually changed.
    assert.match(src, /if \(!next\) return;/);
  });
});

describe("setting a view to a control surface", () => {
  const src = body("handleSetViewSurface");

  test("also sets every screen showing it, or its buttons render dead", () => {
    assert.match(src, /outputs:setMode/, "the screens' modes are never written");
  });

  test("EVERY screen, not just the first — a view can be on several", () => {
    assert.match(src, /for \(const o of next\.outputs\)/);
  });

  test("skips a screen already in the right mode, so it writes only what changed", () => {
    assert.match(src, /=== want\) continue;/);
  });

  test("does nothing further when the first write was refused", () => {
    assert.match(src, /if \(!next\) return;/);
  });
});
