// What a transition declares, and the two rules it must never break.
//
// These used to check interpolated values at a given progress. They no longer
// can, because the interpolation moved off the main thread: the player mounts a
// layer and the compositor animates it. That change WAS the fix — a 600ms
// crossfade sampled by a 100ms clock is six opacity steps, reported from a wall
// as "the crossfade is choppy".
//
// So what is pinned here is what survives that move:
//
//   1. Only opacity and transform are ever animated. Everything else repaints,
//      and a Pi 4 at 1080p cannot hold 60fps through a repaint.
//   2. The declaration does not depend on how far through the transition we are.
//      Mutating an animation property on a running animation RESTARTS it, so a
//      per-tick value would have replaced a six-step fade with one that
//      stuttered ten times a second.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageTransition } from "@main/types/signage";

import { transitionPlan } from "./signage-transition.js";

const KINDS: SignageTransition[] = [
  { kind: "cut", ms: 0 },
  { kind: "crossfade", ms: 600 },
  { kind: "fade-through-black", ms: 800 },
  { kind: "slide", ms: 500, direction: "left" },
  { kind: "slide", ms: 500, direction: "right" },
  { kind: "slide", ms: 500, direction: "up" },
  { kind: "slide", ms: 500, direction: "down" },
  { kind: "wipe", ms: 400, direction: "left" },
];

/** Every property any layer of this plan declares. */
function declared(t: SignageTransition): string[] {
  const plan = transitionPlan(t);
  return [plan.incoming, plan.outgoing, plan.veil ?? {}].flatMap((s) => Object.keys(s));
}

describe("every transition", () => {
  test("animates nothing but opacity and transform", () => {
    // The keyframes carry the animated properties, so what is checked here is
    // that no layer declares a paint-triggering property alongside them.
    const paints = /^(width|height|top|left|right|bottom|margin|padding|filter|clipPath|boxShadow|borderRadius)/;
    for (const t of KINDS) {
      for (const prop of declared(t)) {
        assert.ok(!paints.test(prop), `${t.kind} declares ${prop}, which repaints every frame`);
      }
    }
  });

  test("declares the operator's own duration, not a token", () => {
    // A signage transition length is data an operator typed, not a design
    // token — so it must reach the DOM verbatim.
    for (const t of KINDS) {
      if (t.kind === "cut") continue;
      const plan = transitionPlan(t);
      const withAnimation = [plan.incoming, plan.outgoing, plan.veil ?? {}].filter(
        (s) => "animationDuration" in s,
      );
      assert.ok(withAnimation.length > 0, `${t.kind} animates nothing at all`);
      for (const s of withAnimation) {
        assert.equal((s as { animationDuration: string }).animationDuration, `${t.ms}ms`);
      }
    }
  });

  test("does not depend on how far through it is", () => {
    // The property that keeps the animation from restarting: transitionPlan
    // takes no progress, so calling it on every 100ms tick yields an identical
    // object and React writes nothing to the DOM.
    for (const t of KINDS) {
      assert.deepEqual(transitionPlan(t), transitionPlan(t));
    }
  });
});

describe("a cut", () => {
  test("shows the incoming item and nothing else", () => {
    const plan = transitionPlan({ kind: "cut", ms: 0 });
    assert.equal(plan.showOutgoing, false);
    assert.equal(plan.veil, null);
    assert.equal(plan.incoming.opacity, 1);
    assert.equal("animationName" in plan.incoming, false, "a cut must not animate");
  });

  test("and a zero-length transition of any kind is a cut", () => {
    // Running a 0ms animation is a frame of flicker for no reason.
    for (const kind of ["crossfade", "fade-through-black", "slide", "wipe"] as const) {
      const plan = transitionPlan({ kind, ms: 0 });
      assert.equal(plan.showOutgoing, false, `${kind} at 0ms still mounts a second layer`);
      assert.equal("animationName" in plan.incoming, false, `${kind} at 0ms still animates`);
    }
  });
});

describe("a crossfade", () => {
  const plan = transitionPlan({ kind: "crossfade", ms: 600 });

  test("fades one layer up while the other goes down", () => {
    assert.equal(plan.incoming.animationName, "signage-fade-in");
    assert.equal(plan.outgoing.animationName, "signage-fade-out");
    assert.equal(plan.showOutgoing, true);
  });

  test("holds its end state, so no layer flashes before it starts", () => {
    // Without `both`, a mounted layer paints at full opacity for one frame
    // before the fade takes over — a flicker at the head of every transition.
    assert.equal(plan.incoming.animationFillMode, "both");
    assert.equal(plan.outgoing.animationFillMode, "both");
  });

  test("is linear", () => {
    // An eased crossfade spends its ease where both images are near-opaque,
    // which reads as a hesitation rather than as easing.
    assert.equal(plan.incoming.animationTimingFunction, "linear");
  });
});

describe("fade through black", () => {
  const plan = transitionPlan({ kind: "fade-through-black", ms: 800 });

  test("swaps the item under the opaque middle", () => {
    // The whole point of the kind. Swapping at the start shows the cut through
    // the veil while it is still transparent.
    assert.equal(plan.swapAtMidpoint, true);
  });

  test("is the veil that moves, not the layers", () => {
    // Cross-fading underneath as well would show a ghost of both through black.
    assert.equal(plan.veil?.animationName, "signage-veil");
    assert.equal("animationName" in plan.incoming, false);
    assert.equal(plan.showOutgoing, false, "a second layer under an opaque veil is wasted");
  });

  test("and the veil is actually black", () => {
    assert.equal(plan.veil?.background, "#000");
  });
});

describe("slide and wipe", () => {
  test("slide moves both layers, as though one pushed the other out", () => {
    const plan = transitionPlan({ kind: "slide", ms: 500, direction: "left" });
    assert.equal(plan.incoming.animationName, "signage-slide-in");
    assert.equal(plan.outgoing.animationName, "signage-slide-out");
  });

  test("wipe moves only the incoming one, over a stationary layer", () => {
    const plan = transitionPlan({ kind: "wipe", ms: 400, direction: "left" });
    assert.equal(plan.incoming.animationName, "signage-slide-in");
    assert.equal(plan.showOutgoing, true);
    assert.equal("animationName" in plan.outgoing, false, "wipe moved the layer it reveals");
  });

  test("each direction travels on the axis it names", () => {
    const axis = (dir: "left" | "right" | "up" | "down") => {
      const s = transitionPlan({ kind: "slide", ms: 500, direction: dir }).incoming as Record<string, string>;
      return { dx: s["--signage-dx"], dy: s["--signage-dy"] };
    };
    assert.deepEqual(axis("left"), { dx: "100%", dy: "0" });
    assert.deepEqual(axis("right"), { dx: "-100%", dy: "0" });
    assert.deepEqual(axis("up"), { dx: "0", dy: "100%" });
    assert.deepEqual(axis("down"), { dx: "0", dy: "-100%" });
  });

  test("a stored record with no direction still slides", () => {
    // Old records will not have one, and treating that as a cut would silently
    // disable the transition an operator chose.
    const plan = transitionPlan({ kind: "slide", ms: 500 });
    assert.equal(plan.incoming.animationName, "signage-slide-in");
  });
});
