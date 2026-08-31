import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  CLOSE_FRACTION,
  CLOSE_VELOCITY_PX_MS,
  VELOCITY_WINDOW_MS,
  currentTranslateX,
  dragOffset,
  recentVelocity,
  scrimOpacity,
  settleTarget,
} from "./drawer-drag";

// WHAT THIS FILE CANNOT TEST, said plainly.
//
// Whether the drag FEELS right is a browser question and there is no honest way
// to ask it here. jsdom has no compositor, no layout, no `getComputedStyle`
// worth the name for a transform, and no pointer capture — so "the drawer tracks
// the finger", "it never animates layout" and "the settle is smooth" are all
// verified by driving the real thing at a real width, not by anything below.
//
// What IS testable is the arithmetic those behaviours are made of, and it is
// where every one of the bugs lives: the recency gate that decides whether a
// velocity reading counts, the settle rule that combines velocity with distance,
// the offset clamp, and the matrix read that makes a settling drawer grabbable.
// Each function is pure and each one is exercised here on the exact case that
// motivated it.

describe("velocity is read from a RECENT sample or not at all", () => {
  // The bug: a finger travels fast, stops, rests, and lifts. No pointermove
  // fires while it rests, so the newest sample is as old as the rest — and
  // reading it flings a drawer the operator had deliberately parked.
  test("a finger that stopped before lifting has no velocity", () => {
    const samples = [
      { x: 240, t: 1000 },
      { x: 200, t: 1016 },
      { x: 150, t: 1032 }, // 3.1 px/ms — a hard flick, and then nothing
    ];
    // Lifted 200ms later, having not moved since.
    assert.equal(
      recentVelocity(samples, 1232),
      null,
      "a sample 200ms older than the lift was treated as live velocity",
    );
  });

  test("and the drawer it was parked at 31% therefore springs back", () => {
    const samples = [
      { x: 240, t: 1000 },
      { x: 200, t: 1016 },
      { x: 150, t: 1032 },
    ];
    const width = 256;
    const offset = Math.round(width * 0.31); // 79px, parked
    const v = recentVelocity(samples, 1232);
    assert.equal(
      settleTarget(offset, width, v),
      "open",
      "a stale flick closed a drawer the finger had stopped on",
    );
  });

  test("a sample inside the window is read", () => {
    const samples = [
      { x: 240, t: 1000 },
      { x: 200, t: 1016 },
      { x: 150, t: 1032 },
    ];
    const v = recentVelocity(samples, 1040);
    assert.ok(v !== null, "a sample 8ms old was rejected");
    // Across the whole 32ms window: (240 - 150) / 32.
    assert.ok(Math.abs(v - 90 / 32) < 1e-9, `expected 2.8125 px/ms, got ${v}`);
  });

  test("the reading spans the window, not the last frame", () => {
    // One noisy 8ms frame of 2px is 0.25 px/ms; the 48ms of travel around it is
    // much faster. Reading the pair alone is how a real flick reads as a crawl.
    const samples = [
      { x: 300, t: 1000 },
      { x: 220, t: 1024 },
      { x: 140, t: 1048 },
      { x: 138, t: 1056 },
    ];
    const v = recentVelocity(samples, 1060);
    assert.ok(v !== null && v > 1, `expected the window's speed, got ${v}`);
  });

  test("the boundary is inclusive of the window and nothing past it", () => {
    const samples = [{ x: 200, t: 0 }, { x: 100, t: 40 }];
    assert.ok(recentVelocity(samples, 40 + VELOCITY_WINDOW_MS) !== null, "exactly at the window was rejected");
    assert.equal(recentVelocity(samples, 41 + VELOCITY_WINDOW_MS), null, "one ms past the window was accepted");
  });

  test("degenerate inputs read as no velocity rather than as Infinity", () => {
    assert.equal(recentVelocity([], 0), null);
    assert.equal(recentVelocity([{ x: 10, t: 5 }], 5), null, "one sample is not a velocity");
    assert.equal(
      recentVelocity([{ x: 200, t: 7 }, { x: 100, t: 7 }], 7),
      null,
      "two samples at the same instant divided by a zero dt",
    );
  });

  test("a leftward drag is positive and a rightward one negative", () => {
    assert.ok((recentVelocity([{ x: 200, t: 0 }, { x: 100, t: 20 }], 20) ?? 0) > 0, "closing direction was not positive");
    assert.ok((recentVelocity([{ x: 100, t: 0 }, { x: 200, t: 20 }], 20) ?? 0) < 0, "reopening direction was not negative");
  });
});

describe("the settle takes velocity AND distance", () => {
  const width = 256;

  test("a short fast flick closes", () => {
    // 30px of travel — 12% of the width, nowhere near the distance rule.
    assert.equal(settleTarget(30, width, CLOSE_VELOCITY_PX_MS + 0.1), "closed");
  });

  test("a slow drag held at 31% springs back", () => {
    assert.equal(settleTarget(Math.round(width * 0.31), width, 0.05), "open");
  });

  test("a slow drag past half closes", () => {
    assert.equal(settleTarget(Math.round(width * CLOSE_FRACTION) + 1, width, 0.05), "closed");
    assert.equal(settleTarget(Math.round(width * CLOSE_FRACTION) - 1, width, 0.05), "open");
  });

  test("a flick back towards open reopens whatever the distance", () => {
    // Dragged 80% of the way out, then thrown back. Distance alone would close it.
    assert.equal(settleTarget(width * 0.8, width, -(CLOSE_VELOCITY_PX_MS + 0.1)), "open");
  });

  test("with no trustworthy velocity, distance decides alone", () => {
    assert.equal(settleTarget(width * 0.6, width, null), "closed");
    assert.equal(settleTarget(width * 0.4, width, null), "open");
  });

  test("a drawer with no width cannot have been dragged anywhere", () => {
    assert.equal(settleTarget(0, 0, null), "open", "a zero width decided by NaN");
  });
});

describe("the drag tracks the pointer and stops at the ends", () => {
  test("1:1 with the finger", () => {
    // Grabbed at x=200 on a 256px drawer that was fully open.
    for (const [x, expected] of [[200, 0], [180, 20], [160, 40], [120, 80], [60, 140]] as const) {
      assert.equal(dragOffset(0, 200, x, 256), expected, `at x=${x} the drawer was not ${expected}px out`);
    }
  });

  test("it cannot be dragged further out than it is wide", () => {
    assert.equal(dragOffset(0, 200, -400, 256), 256);
  });

  test("dragging right on an open drawer goes nowhere", () => {
    assert.equal(dragOffset(0, 200, 340, 256), 0, "the drawer slid out from under the scrim");
  });

  test("a grab that starts mid-travel continues from there", () => {
    // Caught at 100px out, then pushed 40px further left.
    assert.equal(dragOffset(100, 200, 160, 256), 140);
    // ...and pulled back past its start.
    assert.equal(dragOffset(100, 200, 320, 256), 0);
  });

  test("the scrim lightens with the travel", () => {
    assert.equal(scrimOpacity(0, 256), 1);
    assert.equal(scrimOpacity(128, 256), 0.5);
    assert.equal(scrimOpacity(256, 256), 0);
    assert.equal(scrimOpacity(999, 256), 0, "the scrim went negative past the end");
    assert.equal(scrimOpacity(10, 0), 1, "a zero width divided into the opacity");
  });
});

describe("a settling drawer can be grabbed, because its LIVE transform is read", () => {
  // The requirement this exists for: testing a stored `open` flag makes a
  // closing drawer unreachable the instant the settle starts. The origin of a
  // new grab comes from the computed matrix instead, which mid-transition is the
  // interpolated value.
  test("the interpolated matrix mid-settle", () => {
    assert.equal(currentTranslateX("matrix(1, 0, 0, 1, -137.4, 0)"), -137.4);
  });

  test("a drawer at rest reads as zero", () => {
    assert.equal(currentTranslateX("none"), 0);
    assert.equal(currentTranslateX(""), 0);
  });

  test("matrix3d puts tx in a different slot, and it is read from there", () => {
    // A compositor-promoted layer reports matrix3d. Reading index 4 out of this
    // gives 0, so a grab mid-settle would snap the drawer back to fully open.
    const m3d = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -88.5, 0, 0, 1)";
    assert.equal(currentTranslateX(m3d), -88.5);
  });

  test("anything unparseable reads as at-rest rather than as NaN", () => {
    assert.equal(currentTranslateX("translateX(-40px)"), 0, "a non-matrix form was read as a number");
    assert.equal(currentTranslateX("matrix(1, 0, 0, 1)"), 0, "a short matrix read past its end");
    assert.equal(currentTranslateX("matrix(a, b, c, d, e, f)"), 0, "NaN reached the offset");
  });

  test("the offset a grab adopts is the negation of the live translation", () => {
    // The full round trip: a drawer caught 137px out, dragged 20px further.
    const live = currentTranslateX("matrix(1, 0, 0, 1, -137, 0)");
    assert.equal(dragOffset(-live, 200, 180, 256), 157);
  });
});
