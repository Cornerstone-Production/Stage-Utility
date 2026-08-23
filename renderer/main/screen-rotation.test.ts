// The transform that makes a portrait TV render portrait.
//
// Arithmetic that looks right and is off by a half-turn, on a wall nobody can
// read until somebody walks over with a laptop. So the shapes are pinned.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { isQuarterTurn, rotatedSize, rotationStyle } from "./screen-rotation";
import { screenRotation, toScreenRotation } from "@main/types/views";

describe("an unrotated screen", () => {
  test("fills the viewport and is not transformed at all", () => {
    const s = rotationStyle(0);
    assert.equal(s.width, "100dvw");
    assert.equal(s.height, "100dvh");
    assert.equal(s.transform, undefined, "a screen mounted normally must not be transformed");
    assert.equal(s.position, undefined, "and must not be pulled out of flow");
  });
});

describe("a quarter turn", () => {
  for (const deg of [90, 270] as const) {
    test(`${deg} lays the content out in a box with its sides swapped`, () => {
      // The part that is easy to miss: a rotated element keeps the dimensions it
      // was given, so a surface sized to the viewport and then turned is laid
      // out landscape and drawn sideways off both edges.
      const s = rotationStyle(deg);
      assert.equal(s.width, "100dvh");
      assert.equal(s.height, "100dvw");
    });

    test(`${deg} turns by exactly that much`, () => {
      assert.equal(rotationStyle(deg).transform, `rotate(${deg}deg)`);
    });

    test(`${deg} is pulled back over the viewport`, () => {
      // Without this the turned element still occupies its pre-rotation
      // footprint in flow, which leaves a scrollbar and an offset.
      const s = rotationStyle(deg);
      assert.equal(s.position, "absolute");
      assert.equal(s.marginTop, "calc(-50dvw)");
      assert.equal(s.marginLeft, "calc(-50dvh)");
    });
  }
});

describe("a half turn", () => {
  test("keeps the viewport's own shape", () => {
    // Upside down is still landscape. Swapping here would letterbox a screen
    // that is simply mounted the other way up.
    const s = rotationStyle(180);
    assert.equal(s.width, "100dvw");
    assert.equal(s.height, "100dvh");
    assert.equal(s.transform, "rotate(180deg)");
  });
});

describe("which turns swap the sides", () => {
  test("the quarter turns do", () => {
    assert.equal(isQuarterTurn(90), true);
    assert.equal(isQuarterTurn(270), true);
  });

  test("and nothing else does", () => {
    assert.equal(isQuarterTurn(0), false);
    assert.equal(isQuarterTurn(180), false);
  });

  test("a screen's size reads swapped at a quarter turn", () => {
    // What the operator should be designing against: a 1920x1080 panel mounted
    // portrait is a 1080x1920 canvas.
    assert.deepEqual(rotatedSize({ w: 1920, h: 1080 }, 90), { w: 1080, h: 1920 });
    assert.deepEqual(rotatedSize({ w: 1920, h: 1080 }, 270), { w: 1080, h: 1920 });
    assert.deepEqual(rotatedSize({ w: 1920, h: 1080 }, 180), { w: 1920, h: 1080 });
    assert.deepEqual(rotatedSize({ w: 1920, h: 1080 }, 0), { w: 1920, h: 1080 });
  });
});

describe("which numbers count as a quarter turn", () => {
  // This rule was written FOUR times — the type helper, the PATCH route's body
  // check, the offline boot record's reader, and a cast in the kiosk shell. Four
  // copies of "which numbers are allowed" is how a wall ends up crooked because
  // one of them let 47 through. It is one function now, and this is it.

  test("the four turns are kept", () => {
    for (const deg of [0, 90, 180, 270]) {
      assert.equal(toScreenRotation(deg), deg);
    }
  });

  test("and everything else is normal", () => {
    // A hand-edited store, a mis-typed form, an older record, a string from a
    // query. All of them are a screen the right way up, never a crooked one.
    for (const bad of [47, -90, 360, 89.9, "90", null, undefined, Number.NaN, Infinity, {}, []]) {
      assert.equal(toScreenRotation(bad), 0, `${JSON.stringify(bad)} was accepted as a rotation`);
    }
  });

  test("a screen record reads through the same rule", () => {
    assert.equal(screenRotation({ rotation: 270 }), 270);
    assert.equal(screenRotation({ rotation: 47 as never }), 0);
    assert.equal(screenRotation({}), 0);
  });
});

describe("the box a rotated screen lays its content out in", () => {
  test("publishes its own width and height, swapped at a quarter turn", () => {
    // Every kiosk root sizes itself against these rather than against the
    // viewport. Without them `h-[100dvh]` resolves to the PANEL's height, so at
    // 90 degrees on a 1920x1080 screen the content filled a 1080x1080 square and
    // left 840px of black - reproduced in a browser before this was written.
    const at90 = rotationStyle(90) as Record<string, string>;
    assert.equal(at90["--screen-w"], "100dvh");
    assert.equal(at90["--screen-h"], "100dvw");

    const at270 = rotationStyle(270) as Record<string, string>;
    assert.equal(at270["--screen-w"], "100dvh");
    assert.equal(at270["--screen-h"], "100dvw");
  });

  test("and publishes them UNSWAPPED at a half turn and at zero", () => {
    // 180 keeps the panel's own proportions, so a root reading these must get
    // the same numbers it would have got from the viewport.
    for (const r of [0, 180] as const) {
      const s = rotationStyle(r) as Record<string, string>;
      assert.equal(s["--screen-w"], "100dvw", `rotation ${r}`);
      assert.equal(s["--screen-h"], "100dvh", `rotation ${r}`);
    }
  });

  test("the box's own width and height agree with what it published", () => {
    // The two could drift: one is what the element is sized to, the other is
    // what the content inside it is told. They are the same fact.
    for (const r of [0, 90, 180, 270] as const) {
      const s = rotationStyle(r) as Record<string, string>;
      assert.equal(s.width, s["--screen-w"], `rotation ${r} width`);
      assert.equal(s.height, s["--screen-h"], `rotation ${r} height`);
    }
  });
});

describe("every kiosk root reads the box, not the viewport", () => {
  test("no kiosk view sizes itself h-[100dvh]", async () => {
    // A source scan, but matched against className STRING LITERALS only - two
    // files mention `h-[100dvh]` in prose explaining this very rule, and a scan
    // over raw text would be satisfied by a comment. Asserts an exact count of
    // zero rather than a floor.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.dirname(new URL(import.meta.url).pathname);

    const offenders: string[] = [];
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
      const src = await fs.readFile(path.join(dir, file), "utf8");
      for (const m of src.matchAll(/className="([^"]*)"/g)) {
        if (m[1].split(/\s+/).includes("h-[100dvh]")) offenders.push(`${file}: ${m[1]}`);
      }
    }
    assert.deepEqual(offenders, [], "these resolve against the panel, not the rotated box");
  });
});
