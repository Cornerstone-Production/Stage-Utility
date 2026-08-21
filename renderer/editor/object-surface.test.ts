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
  matchSurface,
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
      assert.equal(matchSurface(SURFACE_PRESETS[kind]), kind, `${kind} did not match itself`);
    }
  });

  test("a hand-picked background is Custom, and says so", () => {
    // The honest case: somebody chose a colour of their own. Naming a surface
    // over it would be a lie, and would silently discard the colour on the next
    // surface click.
    const s = after(SURFACE_PRESETS.glass, { background: "#ff0000" });
    assert.equal(matchSurface(s), "");
  });

  test("an empty style is Flat, because that is what it draws", () => {
    // Nothing behind the object, no border, no shadow. "Custom" would be the
    // dropdown refusing to name the plainest look there is.
    assert.equal(matchSurface({}), "flat");
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
        assert.equal(matchSurface(s), kind);
        assert.equal(matchTint(s), tint.value);
      });
    }
  }
});

describe("picking a surface keeps the tint", () => {
  test("moving a tinted object between surfaces carries the colour", () => {
    let s = after(SURFACE_PRESETS.solid, applyTint(SURFACE_PRESETS.solid, "green"));
    s = after(s, applySurface(s, "glass"));
    assert.equal(matchSurface(s), "glass");
    assert.equal(matchTint(s), "green");
  });

  test("a surface can always be chosen again, from Custom too", () => {
    // The second half of the report: with the dropdown stuck on Custom, picking
    // an entry appeared to do nothing — because the tint re-applied on top left
    // the style unmatched all over again.
    const custom = after(SURFACE_PRESETS.glass, { background: "#ff0000", boxShadow: 0.9 });
    assert.equal(matchSurface(custom), "");
    const s = after(custom, applySurface(custom, "outline"));
    assert.equal(matchSurface(s), "outline");
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
    // Layouts already on disk carry the opaque value on a glass structure. If
    // that read as Custom, this fix would have left the very thing it set out
    // to remove.
    const legacy = after(SURFACE_PRESETS.glass, { background: "#0d1a15" });
    assert.equal(matchSurface(legacy), "glass");
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
    assert.equal(matchSurface(cleared), "glass");
    assert.equal(matchTint(cleared), "none");
  });

  test("clearing a tint on flat leaves nothing, because flat has nothing", () => {
    const tinted = after(SURFACE_PRESETS.flat, applyTint(SURFACE_PRESETS.flat, "amber"));
    const cleared = after(tinted, applyTint(tinted, "none"));
    assert.equal(cleared.background, null);
    assert.equal(matchSurface(cleared), "flat");
  });
});

describe("a patch that omits a field means that field's zero", () => {
  test("the default card names itself instead of reading as Custom", () => {
    // CARD_PRESETS.neutral is what most objects ship wearing, and it writes no
    // boxShadow at all. Against a preset that writes `boxShadow: 0` that read as
    // a difference, so the surface dropdown said "Custom" for a look nobody had
    // touched — and picking anything from it threw the card's look away.
    const card: LayoutStyle = {
      background: "#141414",
      borderColor: "rgba(255,255,255,0.08)",
      borderWidth: 0.001,
      cornerRadius: 0.0148,
      padding: 0.0148,
    };
    assert.equal(matchSurface(card), "glass");
    assert.equal(matchTint(card), "neutral");
  });

  test("a real shadow still tells Solid from Flat", () => {
    assert.equal(matchSurface(SURFACE_PRESETS.solid), "solid");
    assert.equal(matchSurface(SURFACE_PRESETS.flat), "flat");
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
