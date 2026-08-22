// What a transition is allowed to animate.
//
// These run on a Raspberry Pi 4 driving a 1080p panel, every few seconds, for
// hours. Only `opacity` and `transform` are composited on the GPU; anything else
// — clip-path, filter, width, left — forces a repaint of the whole frame every
// tick, and a wipe that repaints looks worse than a cut. That is why `wipe` is
// implemented as a translating overlay rather than the clip-path it obviously
// wants to be, and why the first test here reads the property NAMES rather than
// trusting the implementation to have stayed honest.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { layerStyles } from "./signage-transition.js";

const animated = (s: object) => Object.keys(s).filter((k) => k !== "willChange");

describe("what a transition animates", () => {
  test("ONLY opacity and transform, so the compositor does the work", () => {
    for (const kind of ["crossfade", "fade-through-black", "slide", "wipe"] as const) {
      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        const s = layerStyles({ kind, ms: 600, direction: "right" }, progress);
        for (const side of [s.incoming, s.outgoing]) {
          for (const prop of animated(side)) {
            assert.ok(
              prop === "opacity" || prop === "transform",
              `${kind} at ${progress} animates ${prop}, which is not compositor-only`,
            );
          }
        }
      }
    }
  });
});

describe("each transition", () => {
  test("a cut is instantaneous at any progress", () => {
    for (const p of [0, 0.5, 1]) {
      const s = layerStyles({ kind: "cut", ms: 0 }, p);
      assert.equal(s.incoming.opacity, 1);
      assert.equal(s.outgoing.opacity, 0);
      assert.equal(s.veilOpacity, 0);
    }
  });

  test("crossfade takes the incoming up as the outgoing comes down", () => {
    const s = layerStyles({ kind: "crossfade", ms: 600 }, 0.25);
    assert.equal(s.incoming.opacity, 0.25);
    assert.equal(s.outgoing.opacity, 0.75);
  });

  test("fade through black is FULLY dark at the midpoint", () => {
    // The one property that distinguishes it from a crossfade. If the veil never
    // reaches 1 it is a crossfade with extra steps, and the two options in the
    // picker do the same thing.
    assert.equal(layerStyles({ kind: "fade-through-black", ms: 600 }, 0).veilOpacity, 0);
    assert.equal(layerStyles({ kind: "fade-through-black", ms: 600 }, 0.5).veilOpacity, 1);
    assert.equal(layerStyles({ kind: "fade-through-black", ms: 600 }, 1).veilOpacity, 0);
  });

  test("fade through black swaps the layers under cover of the veil", () => {
    // Swapping before the veil is opaque shows the cut.
    assert.equal(layerStyles({ kind: "fade-through-black", ms: 600 }, 0.25).outgoing.opacity, 1);
    assert.equal(layerStyles({ kind: "fade-through-black", ms: 600 }, 0.75).incoming.opacity, 1);
  });

  test("slide moves BOTH layers; wipe moves only the incoming one", () => {
    const slide = layerStyles({ kind: "slide", ms: 600, direction: "right" }, 0.5);
    const wipe = layerStyles({ kind: "wipe", ms: 600, direction: "right" }, 0.5);
    assert.notEqual(slide.outgoing.transform, "none");
    assert.equal(wipe.outgoing.transform ?? "none", "none", "wipe moved the outgoing layer");
    assert.notEqual(wipe.incoming.transform, "none");
  });

  test("direction reverses the movement", () => {
    const l = layerStyles({ kind: "slide", ms: 600, direction: "left" }, 0.5).incoming.transform;
    const r = layerStyles({ kind: "slide", ms: 600, direction: "right" }, 0.5).incoming.transform;
    const u = layerStyles({ kind: "slide", ms: 600, direction: "up" }, 0.5).incoming.transform;
    assert.notEqual(l, r);
    assert.notEqual(l, u);
  });

  test("a slide with no direction still moves, rather than doing nothing", () => {
    // direction is optional on the type, and an old stored transition will not
    // have one. Defaulting to a cut here would silently disable the transition.
    const s = layerStyles({ kind: "slide", ms: 600 }, 0.5);
    assert.notEqual(s.incoming.transform, "none");
  });
});

describe("the ends of a transition", () => {
  test("at progress 0 the outgoing layer is fully visible", () => {
    for (const kind of ["crossfade", "slide", "wipe"] as const) {
      const s = layerStyles({ kind, ms: 600, direction: "right" }, 0);
      assert.equal(s.outgoing.opacity, 1, `${kind} started with the outgoing layer already gone`);
    }
  });

  test("at progress 1 the incoming layer is exactly in place", () => {
    // Anything left over here is a permanent offset on a wall screen.
    for (const kind of ["crossfade", "fade-through-black", "slide", "wipe"] as const) {
      const s = layerStyles({ kind, ms: 600, direction: "right" }, 1);
      assert.equal(s.incoming.opacity, 1, `${kind} ended part-faded`);
      assert.equal(s.incoming.transform ?? "none", "none", `${kind} ended off-centre`);
    }
  });

  test("progress outside 0-1 is clamped rather than extrapolated", () => {
    const under = layerStyles({ kind: "crossfade", ms: 600 }, -5);
    const over = layerStyles({ kind: "crossfade", ms: 600 }, 5);
    assert.equal(under.incoming.opacity, 0);
    assert.equal(over.incoming.opacity, 1);
  });
});
