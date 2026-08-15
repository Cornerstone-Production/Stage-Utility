import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

import { defaultStyle } from "../main/layout-objects.js";
import { mapById } from "../main/layout-tree.js";

// Reset is destructive to work an operator may have spent real time on, so the
// two things that matter are that it clears the RIGHT thing completely and the
// wrong things not at all.

const EDITOR = readFileSync(new URL("./layout-editor.tsx", import.meta.url), "utf8");

/** The reset, expressed exactly as layout-editor.tsx does it. */
const reset = (objects: LayoutObject[], id: string) =>
  mapById(objects, id, (o) => ({ ...o, style: defaultStyle(o.config.type) }));

const tuned = (): LayoutObject =>
  ({
    id: "a",
    x: 0.3, y: 0.4, w: 0.2, h: 0.1, z: 5,
    config: { type: "clock", showSeconds: false, format: "24h" },
    style: { color: "#ff0000", fontSize: 0.42, uppercase: true, background: "rgba(1,2,3,0.5)" },
    anchor: { x: "right" },
    keepAspect: true,
    minPx: { w: 44 },
    hidden: false,
  }) as unknown as LayoutObject;

describe("reset to default look", () => {
  test("the style becomes the type's default, exactly", () => {
    const [r] = reset([tuned()], "a");
    assert.deepEqual(r.style, defaultStyle("clock"));
  });

  test("hand-tuned fields are GONE, not merged over", () => {
    // The bug a patch-based reset would ship: a merge cannot clear a key, so
    // `uppercase: true` survives a "reset" and the object still is not default.
    const [r] = reset([tuned()], "a");
    const s = r.style as Record<string, unknown>;
    const d = defaultStyle("clock") as Record<string, unknown>;
    for (const k of ["uppercase", "background"]) {
      assert.equal(s[k], d[k], `${k} must come from the default, not survive the reset`);
    }
  });

  test("geometry is untouched", () => {
    const [r] = reset([tuned()], "a");
    assert.deepEqual([r.x, r.y, r.w, r.h, r.z], [0.3, 0.4, 0.2, 0.1, 5]);
  });

  test("configuration is untouched", () => {
    const [r] = reset([tuned()], "a");
    assert.deepEqual(r.config, { type: "clock", showSeconds: false, format: "24h" });
  });

  test("responsive settings are untouched", () => {
    // These are a separate decision from the look, and re-doing them is fiddly.
    const [r] = reset([tuned()], "a") as unknown as Record<string, unknown>[];
    assert.deepEqual(r.anchor, { x: "right" });
    assert.equal(r.keepAspect, true);
    assert.deepEqual(r.minPx, { w: 44 });
  });

  test("other objects are not touched", () => {
    const other = { ...tuned(), id: "b" };
    const out = reset([tuned(), other], "a");
    assert.deepEqual(out[1].style, other.style, "resetting one object must not reset its neighbours");
  });
});

describe("it is wired the way it is tested", () => {
  test("the editor replaces the style rather than patching it", () => {
    assert.match(
      EDITOR,
      /style:\s*defaultStyle\(o\.config\.type\)/,
      "reset must assign the default style, not spread a patch over the old one",
    );
  });

  test("it goes through the undo stack", () => {
    // Destroying styling with no way back is worse than not offering the button.
    assert.match(
      EDITOR,
      /onResetLook=\{withHistory\(/,
      "reset must be undoable, like every other destructive edit here",
    );
  });
});
