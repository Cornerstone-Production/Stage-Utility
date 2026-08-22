// Surface and tint are two questions, and picking either must never cost you
// the answer to the other. Every test here is a click sequence an operator
// actually performed in the editor and got the wrong answer for.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  SURFACE_PRESETS,
  TINTS,
  applySurface,
  applyTint,
  surfaceOf,
  matchTint,
  isCustomFill,
  tintedBackground,
  type SurfaceKind,
} from "./object-surface.js";

/** What the inspector holds after a click: the old style with the patch on top. */
const after = (style: LayoutStyle, patch: LayoutStyle): LayoutStyle => ({ ...style, ...patch });

describe("a surface names itself", () => {
  test("each preset matches the surface it came from", () => {
    for (const kind of Object.keys(SURFACE_PRESETS) as SurfaceKind[]) {
      assert.equal(surfaceOf(SURFACE_PRESETS[kind]), kind, `${kind} did not match itself`);
    }
  });

  test("a hand-picked colour does not change the material", () => {
    // The reported bug: pick Glass, pick a colour, and the dropdown stopped
    // saying Glass — for a look chosen from that same dropdown two clicks
    // earlier. The choice is stored, so it survives anything done to the fields.
    const s = after(SURFACE_PRESETS.glass, { background: "#ff0000" });
    assert.equal(surfaceOf(s), "glass");
  });

  test("neither does a tint, a radius or a border", () => {
    for (const patch of [
      applyTint(SURFACE_PRESETS.glass, "green"),
      { cornerRadius: 0.05 },
      { borderColor: "#fff", borderWidth: 0.004 },
    ]) {
      assert.equal(surfaceOf(after(SURFACE_PRESETS.glass, patch)), "glass");
    }
  });

  test("an empty style is None, because that is what it draws", () => {
    assert.equal(surfaceOf({}), "flat");
  });

  test("a style from before the choice was recorded is classified by what it draws", () => {
    // Every layout on disk is in this state, and none of them may read as
    // "Custom" — it was never an entry in the list.
    assert.equal(surfaceOf({ background: "rgba(255,255,255,0.04)" }), "glass");
    assert.equal(surfaceOf({ background: "#141414" }), "solid");
    assert.equal(surfaceOf({ borderColor: "rgba(255,255,255,0.35)", borderWidth: 0.0015 }), "outline");
    assert.equal(surfaceOf({ fontSize: 0.06 }), "flat");
  });
});

describe("picking a tint keeps the surface", () => {
  // The bug: the surface was identified by every field INCLUDING background,
  // and the tint writes background — so tinting anything made the dropdown read
  // "Custom" for a material the operator had just chosen from it.
  for (const kind of ["flat", "glass", "solid", "outline"] as SurfaceKind[]) {
    for (const tint of TINTS.filter((t) => t.value !== "none")) {
      test(`${kind} + ${tint.label} is still ${kind}`, () => {
        const s = after(SURFACE_PRESETS[kind], applyTint(SURFACE_PRESETS[kind], tint.value));
        assert.equal(surfaceOf(s), kind);
        assert.equal(matchTint(s), tint.value);
      });
    }
  }
});

describe("picking a surface keeps the tint", () => {
  test("moving a tinted object between surfaces carries the colour", () => {
    let s = after(SURFACE_PRESETS.solid, applyTint(SURFACE_PRESETS.solid, "green"));
    s = after(s, applySurface(s, "glass"));
    assert.equal(surfaceOf(s), "glass");
    assert.equal(matchTint(s), "green");
  });

  test("a surface can always be chosen again", () => {
    const custom = after(SURFACE_PRESETS.glass, { background: "#ff0000" });
    const s = after(custom, applySurface(custom, "outline"));
    assert.equal(surfaceOf(s), "outline");
    // And the colour somebody picked by hand is still theirs.
    assert.equal(s.background, "#ff0000");
  });
});

describe("tinted glass is still glass", () => {
  test("a tint over glass is translucent, not an opaque card", () => {
    // The whole point of glass is that the canvas shows through. An opaque
    // near-black with a glass hairline round it is a card, whatever the
    // dropdown says.
    const bg = tintedBackground("glass", "green");
    assert.match(String(bg), /^rgba\(/, `glass tint must be translucent, got ${bg}`);
    const alpha = Number(String(bg).split(",").pop()?.replace(")", ""));
    assert.ok(alpha > 0 && alpha < 0.5, `glass tint alpha ${alpha} is not see-through`);
  });

  test("the same tint on solid is opaque", () => {
    assert.equal(tintedBackground("solid", "green"), "#0d1a15");
  });

  test("an object tinted before this existed still names itself", () => {
    // Layouts on disk carry the opaque value on a glass structure.
    const legacy = after(SURFACE_PRESETS.glass, { background: "#0d1a15" });
    assert.equal(surfaceOf(legacy), "glass");
    assert.equal(matchTint(legacy), "green");
  });
});

describe("no tint means the surface's own background", () => {
  test("clearing a tint restores glass rather than emptying it", () => {
    // Clearing to null would leave a transparent object under a dropdown still
    // reading "Glass".
    const tinted = after(SURFACE_PRESETS.glass, applyTint(SURFACE_PRESETS.glass, "red"));
    const cleared = after(tinted, applyTint(tinted, "none"));
    assert.equal(cleared.background, SURFACE_PRESETS.glass.background);
    assert.equal(surfaceOf(cleared), "glass");
    assert.equal(matchTint(cleared), "none");
  });

  test("clearing a tint on flat leaves nothing, because flat has nothing", () => {
    const tinted = after(SURFACE_PRESETS.flat, applyTint(SURFACE_PRESETS.flat, "amber"));
    const cleared = after(tinted, applyTint(tinted, "none"));
    assert.equal(cleared.background, null);
    assert.equal(surfaceOf(cleared), "flat");
  });
});

describe("the look most objects ship wearing", () => {
  test("the default card reads as Solid, which is what it draws", () => {
    // CARD_PRESETS.neutral is an OPAQUE near-black with a hairline. It used to
    // read as "Custom" — for a look nobody had touched — and calling it Glass
    // would be the other kind of wrong: nothing shows through it.
    const card: LayoutStyle = {
      background: "#141414",
      borderColor: "rgba(255,255,255,0.08)",
      borderWidth: 0.001,
      cornerRadius: 0.0148,
    };
    assert.equal(surfaceOf(card), "solid");
    assert.equal(matchTint(card), "neutral");
  });

  test("a real shadow still tells Solid from Flat", () => {
    assert.equal(surfaceOf(SURFACE_PRESETS.solid), "solid");
    assert.equal(surfaceOf(SURFACE_PRESETS.flat), "flat");
  });
});

describe("a hand-picked colour is not 'no tint'", () => {
  test("a custom fill reads as custom, not as untinted", () => {
    assert.equal(isCustomFill(after(SURFACE_PRESETS.glass, { background: "#ff0000" })), true);
  });

  test("a surface wearing its own background is untinted, not custom", () => {
    assert.equal(isCustomFill(SURFACE_PRESETS.glass), false);
    assert.equal(isCustomFill(SURFACE_PRESETS.solid), false);
    assert.equal(isCustomFill(SURFACE_PRESETS.flat), false);
  });

  test("a swatch tint is neither", () => {
    const tinted = after(SURFACE_PRESETS.solid, applyTint(SURFACE_PRESETS.solid, "amber"));
    assert.equal(isCustomFill(tinted), false);
    assert.equal(matchTint(tinted), "amber");
  });
});
