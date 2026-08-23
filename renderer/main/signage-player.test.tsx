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
