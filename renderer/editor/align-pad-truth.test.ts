// The Align pad shows the alignment the object will actually render at.
//
// With nothing stored there are two defaults in the app, and which one applies is
// decided by the render path, not by the type's name:
//
//   Readout            `align ?? DEFAULT_READOUT_ALIGN` -> LEFT   (readout.tsx)
//   FitText/Captioned  undefined -> CENTRE                        (layout-renderer)
//
// The pad used IDIOM_TYPES as a stand-in for "renders via Readout". They are not
// the same set, and IDIOM_TYPES cannot be corrected in place: it also decides
// whether an object owns its caption (ObjectContent) and whether defaultStyle
// strips the registry's textAlign, so adding a type to it changes two unrelated
// behaviours.
//
// The five it under-covered, traced through the render path:
//
//   home-streaming, -resi, -youtube   live. Off Home they divert to
//                                     streamingReadout -> Readout with no align,
//                                     and their registry style is BARE so there
//                                     is nothing stored to fall back from.
//   stream-status, pvp-now            latent. Their registry writes "center"
//                                     today, so a fresh object never reaches the
//                                     fallback; an imported or older one does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { IDIOM_TYPES, READOUT_ALIGNED_TYPES, DEFAULT_READOUT_ALIGN } from "../../main/types/readout-types.js";
import type { LayoutObjectType } from "@main/types/views.js";

/** What the pad shows for a type with nothing stored. */
const padShows = (t: LayoutObjectType) =>
  READOUT_ALIGNED_TYPES.has(t) ? DEFAULT_READOUT_ALIGN : "center";

describe("the pad's basis is the render path, not the type-sizing set", () => {
  it("left is what a Readout does with nothing stored", () => {
    assert.equal(DEFAULT_READOUT_ALIGN, "left");
  });

  it("every idiom type is still covered", () => {
    // IDIOM_TYPES all render through Readout; the new set must not lose any.
    for (const t of IDIOM_TYPES) {
      assert.ok(READOUT_ALIGNED_TYPES.has(t), `${t} renders left but the pad would say centre`);
    }
  });

  it("and the five IDIOM_TYPES did not cover are covered now", () => {
    for (const t of ["home-streaming", "home-streaming-resi", "home-streaming-youtube", "stream-status", "pvp-now"] as LayoutObjectType[]) {
      assert.ok(!IDIOM_TYPES.has(t), `${t} is in IDIOM_TYPES now — this test is out of date`);
      assert.equal(padShows(t), "left", `the pad still says centre for ${t}, which renders left`);
    }
  });

  it("the two sets are genuinely different, and by exactly five", () => {
    // EXACT. If they ever coincide, the reason this set exists has gone and
    // somebody should delete it rather than let it drift as a silent copy.
    assert.equal(
      READOUT_ALIGNED_TYPES.size - IDIOM_TYPES.size,
      5,
      `the set differs from IDIOM_TYPES by ${READOUT_ALIGNED_TYPES.size - IDIOM_TYPES.size}, not 5`,
    );
  });

  it("a type that draws its own text still reads centre", () => {
    // The other half. Over-covering would be the same bug pointing the other way.
    for (const t of ["text", "current-service-item", "next-service-item", "current-slide-text"] as LayoutObjectType[]) {
      assert.equal(padShows(t), "center", `${t} renders centre but the pad would say left`);
    }
  });
});

describe("the two defects found while tracing", () => {
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

  it("a wireless tile does not jump left when the fleet goes dark", () => {
    // The populated state honours the stored alignment and the empty one did
    // not, so a right-aligned tile moved at the moment it is being looked at.
    const s = src("../main/layout-renderer.tsx");
    const empties = [...s.matchAll(/<Readout value="—" dim[^/]*\/>/g)].map((m) => m[0]);
    assert.equal(empties.length, 2, `expected the two wireless empty states, found ${empties.length}`);
    for (const e of empties) {
      assert.match(e, /align=\{o\.style\?\.textAlign\}/, `an empty state drops the alignment: ${e}`);
    }
  });

  it("the Home PvP card names its alignment instead of inheriting left", () => {
    // PvpNowObject hands `align` to Readout, which defaults LEFT. Dropping it
    // made the card render left while its pad said centre and every cell in the
    // pad did nothing.
    const s = src("../app/home/cards.tsx");
    const call = /<PvpNowObject[\s\S]*?\/>/.exec(s)?.[0] ?? "";
    assert.match(call, /align="center"/, "PvpNowCard still drops align");
  });
});
