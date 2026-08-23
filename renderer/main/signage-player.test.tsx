// The player is a pure function of (entry, now).
//
// It holds no timers, no refs and no "previous item" state, and that is the
// point: the transition is derived from the clock exactly like the item is, so
// two screens showing the same playlist are mid-crossfade at the same instant
// rather than merely arriving at the same graphic eventually.
//
// It also has to be black, immediately and without complaint, in every case
// where there is nothing to play. A signage screen that renders a placeholder or
// an error is a signage screen with a placeholder on the wall.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import type { SignageTransition } from "@main/types/signage";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { SignagePlayer } = await import("./signage-player.js");

after(() => {
  cleanup();
  teardown();
});

// No per-item transition: an item inherits the playlist's unless it overrides
// it, and baking a "cut" in here would silently disable every playlist-level
// transition these tests are about.
const item = (url: string, durationMs = 8000) => ({
  url,
  mime: "image/png",
  durationMs,
  fit: "contain" as const,
  bytes: 1,
});

function entryWith(items: ReturnType<typeof item>[], transition: SignageTransition = { kind: "cut", ms: 0 }) {
  return {
    from: 0,
    until: 1e12,
    reason: "schedule",
    reasonLabel: "Weekend",
    playlist: { id: "p1", startedAt: 0, fit: "contain", transition, items },
  } as never;
}

function draw(entry: unknown, nowMs: number) {
  cleanup();
  return render(React.createElement(SignagePlayer as never, { entry, nowMs })).container;
}

const TWO = [item("/a.png"), item("/b.png")];

describe("the signage player", () => {
  test("shows the item the clock says, not always the first", () => {
    assert.match(draw(entryWith(TWO), 9000).innerHTML, /b\.png/);
    assert.match(draw(entryWith(TWO), 1000).innerHTML, /a\.png/);
  });

  test("wraps with the cycle", () => {
    assert.match(draw(entryWith(TWO), 17000).innerHTML, /a\.png/);
  });

  test("a blank entry renders no media at all", () => {
    const blank = { from: 0, until: 1e12, reason: "blank", reasonLabel: "" } as never;
    const c = draw(blank, 5000);
    assert.equal(c.querySelector("img"), null, "a blank entry still rendered an image");
    assert.equal(c.querySelector("video"), null, "a blank entry still rendered a video");
  });

  test("a null entry is black too, never a crash or a placeholder", () => {
    const c = draw(null, 5000);
    assert.equal(c.querySelector("img"), null);
    assert.ok(!/placeholder|error|nothing/i.test(c.textContent ?? ""), "a wall screen was given text");
  });

  test("an empty playlist is black rather than a division by zero", () => {
    const c = draw(entryWith([]), 5000);
    assert.equal(c.querySelector("img"), null);
  });

  test("a one-item playlist is a static graphic", () => {
    const c = draw(entryWith([item("/only.png")]), 999999);
    assert.equal(c.querySelectorAll("img").length, 1);
    assert.match(c.innerHTML, /only\.png/);
  });
});

describe("a transition, mid-flight", () => {
  const CROSSFADE: SignageTransition = { kind: "crossfade", ms: 600 };

  test("draws BOTH items while it is happening", () => {
    // 8000 is the boundary; 8300 is halfway through a 600ms crossfade.
    const c = draw(entryWith(TWO, CROSSFADE), 8300);
    const srcs = [...c.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    assert.deepEqual(srcs.sort(), ["/a.png", "/b.png"], "only one layer was drawn mid-transition");
  });

  test("draws only one once it is over", () => {
    const c = draw(entryWith(TWO, CROSSFADE), 9000);
    assert.equal(c.querySelectorAll("img").length, 1);
  });

  test("is derived from the clock, so the same instant looks the same twice", () => {
    // No refs, no timers: this is what lets two screens be mid-crossfade
    // together rather than merely landing on the same graphic eventually.
    assert.equal(draw(entryWith(TWO, CROSSFADE), 8300).innerHTML, draw(entryWith(TWO, CROSSFADE), 8300).innerHTML);
  });

  test("does not transition a single item into itself", () => {
    // The previous item of a one-item playlist IS the item. Crossfading it with
    // itself is a visible flicker every cycle for no reason.
    const c = draw(entryWith([item("/only.png")], CROSSFADE), 8100);
    assert.equal(c.querySelectorAll("img").length, 1);
  });

  test("wraps the previous item round the end of the cycle", () => {
    // At the very start of a revolution the outgoing item is the LAST one.
    const c = draw(entryWith(TWO, CROSSFADE), 16100);
    const srcs = [...c.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    assert.deepEqual(srcs.sort(), ["/a.png", "/b.png"]);
  });

  test("a per-item transition overrides the playlist's", () => {
    const items = [item("/a.png"), { ...item("/b.png"), transition: { kind: "cut" as const, ms: 0 } }];
    const c = draw(entryWith(items, CROSSFADE), 8300);
    assert.equal(c.querySelectorAll("img").length, 1, "a per-item cut still drew two layers");
  });

  test("hands the fade to the compositor rather than stepping it", () => {
    // The choppiness, in one assertion. The player is a pure function of a clock
    // that ticks every 100ms, so a 600ms crossfade interpolated in the render
    // was six opacity steps — reported from a wall as "choppy and sucks".
    const c = draw(entryWith(TWO, CROSSFADE), 8300);
    const layers = [...c.querySelectorAll("img")];
    const names = layers.map((l) => (l as HTMLElement).style.animationName).sort();
    assert.deepEqual(names, ["signage-fade-in", "signage-fade-out"]);
    for (const l of layers) {
      assert.equal((l as HTMLElement).style.animationDuration, "600ms");
    }
  });

  test("and its declaration does not change between ticks", () => {
    // What keeps that fade smooth once it has started. Mutating an animation
    // property on a running animation RESTARTS it, so a style that varied with
    // the clock would trade six steps for a stutter ten times a second.
    const styleAt = (nowMs: number) =>
      [...draw(entryWith(TWO, CROSSFADE), nowMs).querySelectorAll("img")]
        .map((l) => (l as HTMLElement).getAttribute("style"))
        .sort();

    // Every tick across the 600ms crossfade that starts at 8000.
    const first = styleAt(8100);
    for (let t = 8100; t < 8600; t += 100) {
      assert.deepEqual(styleAt(t), first, `the layer style changed at ${t}ms into the transition`);
    }
  });

  test("stops declaring an animation once the transition is over", () => {
    // An animation left on a layer that is simply sitting there keeps it on its
    // own compositor surface for the whole eight seconds it is on screen.
    const c = draw(entryWith(TWO, CROSSFADE), 9000);
    const layer = c.querySelector("img") as HTMLElement;
    assert.equal(layer.style.animationName, "", "a still graphic is still animating");
  });
});

describe("video", () => {
  test("renders muted and inline, or a browser will refuse to autoplay it", () => {
    const clip = { ...item("/c.mp4"), mime: "video/mp4", durationMs: 42000 };
    const c = draw(entryWith([clip]), 1000);
    const v = c.querySelector("video");
    assert.ok(v, "a video item did not render a video element");
    assert.ok(v.hasAttribute("muted") || (v as HTMLVideoElement).muted, "not muted, so autoplay is blocked");
    assert.ok(v.hasAttribute("playsinline") || v.hasAttribute("playsInline"));
  });
});

const vid = (url: string, durationMs = 8000) => ({
  url,
  mime: "video/mp4",
  durationMs,
  fit: "contain" as const,
  bytes: 1,
});

/** Render at `t1`, then advance to `t2` in the SAME container, so React
 *  reconciles rather than starting over. Element identity is the whole point.
 *
 *  Asserted on <img> rather than <video>: the property under test is React's
 *  reconciliation, which does not care about the tag, and jsdom stalls for
 *  thirty seconds when a <video> is remounted - which turns a clean assertion
 *  failure into a timeout. The consequence being guarded against is a video one;
 *  the mechanism is not. */
function advance(entry: unknown, t1: number, t2: number) {
  cleanup();
  const r = render(React.createElement(SignagePlayer as never, { entry, nowMs: t1 }));
  const before = [...r.container.querySelectorAll("img")];
  r.rerender(React.createElement(SignagePlayer as never, { entry, nowMs: t2 }));
  return { before, after: [...r.container.querySelectorAll("img")], container: r.container };
}

describe("crossfading out of an item", () => {
  test("keeps the SAME element, so an outgoing VIDEO does not restart", () => {
    // Two key namespaces (`out-N` and `in-N`) meant the element playing item N
    // was unmounted and a fresh one mounted for the outgoing layer. For a video
    // that is a new <video>: a 30-second clip crossfading out showed its FIRST
    // 600ms rather than its last, and two decoders spun up per boundary on a Pi.
    const e = entryWith(TWO, { kind: "crossfade", ms: 600 });

    // 7900: item A alone. 8100: item B incoming, A outgoing mid-crossfade.
    const { before, after } = advance(e, 7900, 8100);
    assert.equal(before.length, 1, "expected one layer before the boundary");
    assert.equal(after.length, 2, "expected both layers during the crossfade");

    const outgoing = after.find((v) => v.getAttribute("src")?.startsWith("/a.png"));
    assert.ok(outgoing, "the outgoing item is not on screen at all");
    assert.equal(outgoing, before[0], "the outgoing element was rebuilt, so a video would restart");
  });

  test("and the incoming one is genuinely a new element", () => {
    // The other half: if everything were reused the incoming item would inherit
    // the outgoing element's playback position.
    const { before, after } = advance(entryWith(TWO, { kind: "crossfade", ms: 600 }), 7900, 8100);
    const incoming = after.find((v) => v.getAttribute("src")?.startsWith("/b.png"));
    assert.ok(incoming);
    assert.ok(!before.includes(incoming), "the incoming item reused an element already on screen");
  });

  test("a video still renders as a <video>, so the case above is the real one", () => {
    const c = draw(entryWith([vid("/a.mp4"), vid("/b.mp4")], { kind: "cut", ms: 0 }), 1000);
    assert.ok(c.querySelector("video"), "a video item did not render a video element");
  });
});

describe("a transition longer than the item it runs over", () => {
  test("still reaches the incoming item inside that item's own slot", () => {
    // MAX_TRANSITION_MS is 3000 and MIN_ITEM_MS is 100, and nothing clamps one
    // against the other - so a 3s fade-through-black on a 1s trimmed clip held
    // `showingPrevious` true for the item's whole slot and the wall showed item
    // N-1 during item N's turn, every revolution, forever.
    const items = [item("/a.png", 1000), item("/b.png", 1000)];
    const e = entryWith(items, { kind: "fade-through-black", ms: 3000 });

    // Item B's slot is 1000..2000. Past its own midpoint the swap must have
    // happened.
    assert.match(draw(e, 1700).innerHTML, /b\.png/, "the wall is a graphic behind");
    // And the first half still shows the outgoing one, so the swap-at-midpoint
    // behaviour is not simply disabled.
    assert.match(draw(e, 1200).innerHTML, /a\.png/);
  });

  test("a transition that fits is untouched", () => {
    const items = [item("/a.png", 8000), item("/b.png", 8000)];
    const e = entryWith(items, { kind: "fade-through-black", ms: 600 });
    assert.match(draw(e, 8100).innerHTML, /a\.png/, "first half still shows the outgoing item");
    assert.match(draw(e, 8400).innerHTML, /b\.png/, "second half shows the incoming one");
  });
});
