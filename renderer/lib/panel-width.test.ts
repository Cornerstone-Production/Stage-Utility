import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

// One resize implementation, used by two panels.
//
// The sidebar's version already handled the things a drag needs and a naive copy
// would miss: rAF batching so a drag does not re-render the shell per event, and
// pointercancel so a stolen touch does not leave the panel stuck mid-drag. A
// second copy is how the inspector ends up with neither.

const SRC = readFileSync(new URL("./use-sidebar-width.ts", import.meta.url), "utf8");
const EDITOR = readFileSync(new URL("../editor/layout-editor.tsx", import.meta.url), "utf8");
const RAIL = readFileSync(new URL("../app/rail.tsx", import.meta.url), "utf8");

describe("there is one implementation", () => {
  test("the drag lives in exactly one place", () => {
    assert.equal((SRC.match(/const startResize = useCallback/g) ?? []).length, 1);
  });

  test("both panels reach it through the shared hook", () => {
    assert.match(SRC, /export function useSidebarWidth/);
    assert.match(SRC, /export function useInspectorWidth/);
    assert.match(SRC, /return usePanelWidth\(\{[\s\S]*?SIDEBAR_WIDTH_KEY/);
    assert.match(SRC, /return usePanelWidth\(\{[\s\S]*?INSPECTOR_WIDTH_KEY/);
  });

  test("neither panel writes its own pointer handling", () => {
    // A local pointermove/rAF in a component is the copy this guards against.
    for (const [name, src] of [["editor", EDITOR], ["rail", RAIL]] as const) {
      assert.ok(
        !/requestAnimationFrame[\s\S]{0,200}clientX/.test(src),
        `${name} appears to implement its own resize drag`,
      );
    }
  });
});

describe("the two panels are configured differently, on purpose", () => {
  test("they do not share a storage key", () => {
    // One key for both means resizing one resizes the other on next load.
    const keys = [...SRC.matchAll(/_WIDTH_KEY = "([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(keys).size, keys.length, `duplicate storage key: ${keys}`);
  });

  test("the inspector grows LEFTWARD", () => {
    // Its handle is on its left edge, so dragging toward the middle must make it
    // wider. Sharing the sidebar's direction would make it shrink as you pull.
    assert.match(SRC, /edge:\s*"right"/);
    assert.match(SRC, /edge === "right" \? -delta : delta/);
  });
});
