// Meters ease between samples over one sample interval, draw only while visible,
// and never sweep up from a stale height after the page was hidden.
//
// What a meter LOOKS like (its colour bands, the bar inside its track) is checked
// in a browser, not here: jsdom loads no stylesheet and lays nothing out.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { METER_STALE_MS, MeterAnimator, meterEase, tweenMeter, type AnimatorEnv } from "./meter-tween.js";

describe("tweenMeter", () => {
  test("tweenMeter reaches the target in exactly one interval and never overshoots", () => {
    for (const [from, to] of [[0, 1], [1, 0], [0.2, 0.7], [0.9, 0.1], [0.5, 0.5]] as [number, number][]) {
      assert.equal(tweenMeter(from, to, 0, 100), from, "starts where it was");
      assert.equal(tweenMeter(from, to, 100, 100), to, "exactly the target at one interval");
      assert.equal(tweenMeter(from, to, 250, 100), to, "and stays there");
      let prev = from;
      for (let ms = 1; ms < 100; ms++) {
        const v = tweenMeter(from, to, ms, 100);
        assert.ok(v >= Math.min(from, to) && v <= Math.max(from, to), `${from}->${to} at ${ms} ms drew ${v}, outside the two`);
        assert.ok(from <= to ? v >= prev : v <= prev, `${from}->${to} went backwards at ${ms} ms`);
        prev = v;
      }
      assert.notEqual(tweenMeter(0, 1, 99, 100), 1, "not there before the interval is up");
    }
  });

  test("the curve is the app's --motion-ease, which arrives and settles", () => {
    assert.ok(meterEase(0.5) > 0.5, "ahead of linear halfway: it arrives quickly");
    assert.equal(meterEase(0), 0);
    assert.equal(meterEase(1), 1);
  });

  test("a zero or missing interval draws the target", () => {
    assert.equal(tweenMeter(0, 0.8, 10, 0), 0.8);
    assert.equal(tweenMeter(0, 0.8, 10, Number.NaN), 0.8);
  });
});

/** A clock and a frame queue the test turns by hand. */
function fakeEnv() {
  let now = 0;
  let hidden = false;
  let next = 1;
  const frames = new Map<number, (t: number) => void>();
  const env: AnimatorEnv = {
    now: () => now,
    requestFrame: (cb) => {
      const id = next++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    hidden: () => hidden,
    reducedMotion: () => false,
  };
  return {
    env,
    advance(ms: number) {
      now += ms;
    },
    /** Run the frames queued now, as one browser frame does. */
    frame() {
      const due = [...frames.entries()];
      frames.clear();
      for (const [, cb] of due) cb(now);
    },
    pending: () => frames.size,
    hide(h: boolean) {
      hidden = h;
    },
  };
}

describe("MeterAnimator", () => {
  test("eases to each sample over the measured sample spacing, then stops asking for frames", () => {
    const f = fakeEnv();
    const a = new MeterAnimator(f.env);
    const drawn: number[] = [];
    a.add("m", { draw: (l) => drawn.push(l) });
    a.sample("m", 0.2); // first sample: jumps
    assert.equal(drawn.at(-1), 0.2);
    assert.equal(f.pending(), 0, "nothing to animate after a jump");

    f.advance(50);
    a.sample("m", 0.6); // 50 ms after the last: a 50 ms tween
    assert.equal(f.pending(), 1);
    f.advance(25);
    f.frame();
    const mid = drawn.at(-1)!;
    assert.ok(mid > 0.2 && mid < 0.6, `halfway through it is between the two, drew ${mid}`);
    f.advance(25);
    f.frame();
    assert.equal(drawn.at(-1), 0.6, "there at one interval");
    assert.equal(f.pending(), 0, "no frame requested once nothing moves");
    assert.equal(a.running, false);
  });

  test("a hidden page asks for no frames, and the first sample after waking jumps", () => {
    const f = fakeEnv();
    const a = new MeterAnimator(f.env);
    const drawn: number[] = [];
    a.add("m", { draw: (l) => drawn.push(l) });
    a.sample("m", 0.1);
    f.advance(50);
    a.sample("m", 0.9);
    assert.equal(f.pending(), 1);

    f.hide(true);
    a.pause();
    assert.equal(f.pending(), 0, "pausing cancels the frame");
    f.advance(50);
    a.sample("m", 0.3);
    assert.equal(f.pending(), 0, "a hidden page asks for nothing");

    f.hide(false);
    f.advance(50);
    a.sample("m", 0.7);
    assert.equal(f.pending(), 0, "the first sample after waking is drawn at once, not tweened");
    assert.equal(drawn.at(-1), 0.7);
  });

  test("a page hidden mid-tween stops asking for frames even before the pause arrives", () => {
    const f = fakeEnv();
    const a = new MeterAnimator(f.env);
    a.add("m", { draw: () => {} });
    a.sample("m", 0.1);
    f.advance(50);
    a.sample("m", 0.9);
    f.hide(true);
    f.advance(10);
    f.frame();
    assert.equal(f.pending(), 0, "a hidden page kept the loop running");
  });

  test("a sample after a long silence jumps instead of sweeping from the old height", () => {
    const f = fakeEnv();
    const a = new MeterAnimator(f.env);
    const drawn: number[] = [];
    a.add("m", { draw: (l) => drawn.push(l) });
    a.sample("m", 0.1);
    f.advance(METER_STALE_MS);
    a.sample("m", 0.8);
    assert.equal(drawn.at(-1), 0.8);
    assert.equal(f.pending(), 0);
  });
});
