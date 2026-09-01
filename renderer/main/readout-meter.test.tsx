// The two defects reported together off one screenshot of three ProVideoPlayer
// widgets: a progress rule that stepped once a second, and a widget whose VALUE
// was blank while its caption, its sub-label and its footer all rendered.
//
// WHAT A TEST CANNOT SEE HERE. jsdom does no layout and runs no animations, so
// none of the following is asserted anywhere in this file and none of it can be:
// that the fill actually slides, that it slides smoothly, what width it has at
// any moment, that the value is legible, or that anything is clipped. Those were
// checked by driving a real browser against a real ProVideoPlayer — see the
// commit. A test that claimed any of them would pass on the bug.
//
// What IS real in JS, and is what these guard:
//
//   - the DECISION the component makes about whether to interpolate, both as a
//     pure function and as the duration it actually writes onto the element;
//   - that the value's box is sized by the composition's own budget and is not
//     the one child flexbox may shrink, which is the mechanism that blanked it;
//   - that the composition never hands out a sub-label, a rule or a footer
//     without a value to go with them.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import {
  meterSmooth, meterPct, METER_TICK_MS, METER_SNAP_JUMP_PCT, METER_DRIFT_PCT,
} from "./readout-meter.js";
import { fitComposition, VALUE_LEADING } from "./readout-size.js";
import type { PvpLayerDTO, PvpStatusDTO } from "@main/types/pvp";

// The DOM has to exist before the component module is evaluated, which is why
// this is not a `before` hook — see number-input.test.tsx.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { Readout } = await import("./readout.js");
const { PvpNowObject } = await import("./pvp-now.js");
const { PvpObject } = await import("./pvp-object.js");

after(() => {
  cleanup();
  teardown();
});

const CLIP = "layer-1 clip-a";

describe("when the progress rule may glide, and when it must snap", () => {
  test("a normal tick glides", () => {
    // The whole point. Without this the bar is redrawn at a new width once a
    // second and JUMPS there, which is what was reported.
    assert.equal(meterSmooth({ key: CLIP, pct: 40 }, CLIP, 41.7), true);
  });

  test("the first reading snaps", () => {
    // Nothing to glide from. Gliding would animate a second of progress that
    // never happened, on every widget, every time a display woke up.
    assert.equal(meterSmooth(null, CLIP, 40), false);
  });

  test("a different clip snaps", () => {
    // The two fractions measure different things. 40% of one clip and 41% of
    // the next are not a second apart, they are unrelated.
    assert.equal(meterSmooth({ key: CLIP, pct: 40 }, "layer-1 clip-b", 41), false);
  });

  test("going backwards snaps", () => {
    // THE case that reads as a bug rather than as a rewind: glided, the bar
    // slides backwards across the widget for a whole second. A cue advance, a
    // restart and a loop all land here.
    assert.equal(meterSmooth({ key: CLIP, pct: 90 }, CLIP, 2), false);
  });

  test("a jump forwards snaps", () => {
    // A scrub, a seek, or a display that was asleep through a keepalive.
    assert.equal(meterSmooth({ key: CLIP, pct: 10 }, CLIP, 10 + METER_SNAP_JUMP_PCT + 0.1), false);
    // And the boundary is inclusive, so a tick exactly at the threshold still
    // glides — otherwise the constant means one thing here and another in the
    // comment that documents it.
    assert.equal(meterSmooth({ key: CLIP, pct: 10 }, CLIP, 10 + METER_SNAP_JUMP_PCT), true);
  });

  test("drifting a hair backwards is a tick, not a rewind", () => {
    // The server re-anchors whenever a clip drifts past a second. Landing just
    // behind where the client had interpolated to is a sub-pixel retreat; called
    // a discontinuity, it stalls a smooth bar for a whole second.
    assert.equal(meterSmooth({ key: CLIP, pct: 40 }, CLIP, 40 - METER_DRIFT_PCT), true);
    // And the real rewinds are two orders of magnitude bigger, so this cannot
    // swallow one.
    assert.equal(meterSmooth({ key: CLIP, pct: 40 }, CLIP, 40 - METER_DRIFT_PCT * 2), false);
  });

  test("standing still is not a snap", () => {
    // A PAUSED clip. computePvpProgress multiplies by playbackRate, so at rate 0
    // the fraction is identical every tick — the width never changes and there
    // is nothing to animate. This asserts the decision does not treat "no
    // change" as a discontinuity, which would leave the rule flipping its
    // duration between 0 and 1000ms while nothing moved.
    assert.equal(meterSmooth({ key: CLIP, pct: 55 }, CLIP, 55), true);
  });
});

describe("the duration the rule actually writes onto the element", () => {
  // The same decisions, made by the real component through its real layout
  // effect, rather than by calling the pure function directly. jsdom cannot see
  // the animation; it can see the duration chosen for it.
  const fill = (c: HTMLElement): HTMLElement => {
    const el = c.querySelector<HTMLElement>(".su-meter-fill");
    assert.ok(el, "the progress rule drew no fill");
    return el;
  };
  const ms = (c: HTMLElement): string => fill(c).style.getPropertyValue("--su-meter-ms");

  test("snaps on the first paint, then glides tick to tick", () => {
    const { container, rerender } = render(<Readout value="clip" meter={0.1} meterKey={CLIP} />);
    assert.equal(ms(container), "0ms", "the first paint animated up from nothing");
    rerender(<Readout value="clip" meter={0.2} meterKey={CLIP} />);
    assert.equal(ms(container), `${METER_TICK_MS}ms`, "a normal tick did not glide — the bar steps");
    cleanup();
  });

  test("snaps when the clip changes, and when the bar goes backwards", () => {
    const { container, rerender } = render(<Readout value="clip" meter={0.4} meterKey={CLIP} />);
    rerender(<Readout value="clip" meter={0.5} meterKey={CLIP} />);
    assert.equal(ms(container), `${METER_TICK_MS}ms`);
    rerender(<Readout value="other" meter={0.05} meterKey="layer-1 clip-b" />);
    assert.equal(ms(container), "0ms", "the bar glided across a cut to a different clip");
    rerender(<Readout value="other" meter={0.15} meterKey="layer-1 clip-b" />);
    assert.equal(ms(container), `${METER_TICK_MS}ms`);
    rerender(<Readout value="other" meter={0.02} meterKey="layer-1 clip-b" />);
    assert.equal(ms(container), "0ms", "the bar glided BACKWARDS across the widget");
    cleanup();
  });

  test("holds still while the value does", () => {
    // A paused clip, end to end: same fraction, same width, nothing to creep to.
    const { container, rerender } = render(<Readout value="clip" meter={0.6} meterKey={CLIP} />);
    rerender(<Readout value="clip" meter={0.6} meterKey={CLIP} />);
    assert.equal(fill(container).style.width, "60%", "a paused bar moved");
    cleanup();
  });
});

describe("a fraction that is not a number", () => {
  test("draws an empty bar rather than bringing the widget down", () => {
    // The interpolation compares this render's value with the last one, and
    // NaN !== NaN — so an unguarded NaN re-fires the render-phase update on
    // every pass and React gives up with "Too many re-renders", taking the
    // whole readout with it. The stepping version it replaced merely wrote an
    // invalid `width: NaN%` that the browser dropped, so this failure mode is
    // one the fix introduced and has to carry its own guard.
    assert.equal(meterPct(Number.NaN), 0);
    assert.equal(meterPct(Number.POSITIVE_INFINITY), 0);
    assert.equal(meterPct(-3), 0);
    assert.equal(meterPct(7), 100);
    assert.equal(meterPct(0.25), 25);

    const { container, rerender } = render(<Readout value="clip" meter={Number.NaN} />);
    const fill = container.querySelector<HTMLElement>(".su-meter-fill");
    assert.ok(fill, "a NaN fraction drew no rule at all");
    assert.equal(fill.style.width, "0%");
    // And a second render with the same NaN must not re-enter either.
    rerender(<Readout value="clip" meter={Number.NaN} />);
    assert.equal(container.querySelectorAll(".su-meter-fill").length, 1);
    cleanup();
  });
});

describe("the value is not the line the box gives up", () => {
  // THE blank widget. Every other line of the composition carries flexShrink 0,
  // so the value's wrapper was the only child flexbox could take an overrun out
  // of — and the overrun was guaranteed, because the wrapper inherited the
  // page's 24px leading while fitComposition had budgeted valuePx * 1.05 for it.
  //
  // Measured in a browser at a 42px box before the fix: the wrapper was squeezed
  // to 8.8px around a 24px line box whose text sat at y=12, so `overflow: hidden`
  // removed the value completely and the caption, sub-line, rule and footer all
  // rendered. "remaining" with nothing above it.
  const wrapper = (c: HTMLElement): HTMLElement => {
    const el = c.querySelector<HTMLElement>("[data-readout-value]");
    assert.ok(el, "the readout drew no value");
    return el;
  };

  test("its line box is the one the composition budgeted, not the page's", () => {
    const { container } = render(
      <Readout caption="ProVideoPlayer" value="clip.mp4" sub="remaining" meter={0.5} footer="Next" />,
    );
    const el = wrapper(container);
    const { valuePx } = fitComposition(0, true, true, false, { meter: true, footer: true });
    assert.equal(
      el.style.lineHeight,
      String(VALUE_LEADING),
      "the value's wrapper takes its leading from the page, so its line box is taller than its budget",
    );
    assert.equal(
      el.style.fontSize,
      `${valuePx}px`,
      "the value's wrapper is not sized from the composition, so its strut is somebody else's",
    );
    cleanup();
  });

  test("and nothing in the composition is flexbox's shock absorber", () => {
    // The invariant, stated over the whole composition rather than over the one
    // element that was wrong: if EVERY line refuses to shrink, an overrun clips
    // the ENDS of the box — the caption and the footer — and can never again
    // take the whole cost out of the one line in the middle.
    const { container } = render(
      <Readout caption="ProVideoPlayer" value="clip.mp4" sub="remaining" meter={0.5} footer="Next" />,
    );
    const root = wrapper(container).parentElement;
    assert.ok(root);
    const soft = Array.from(root.children).filter(
      (n) => (n as HTMLElement).style.position !== "absolute" && (n as HTMLElement).style.flexShrink !== "0",
    );
    assert.deepEqual(
      soft.map((n) => n.tagName + (n.hasAttribute("data-readout-value") ? "[value]" : "")),
      [],
      "a line of the composition can still be squeezed, and it will be the one that is squeezed",
    );
    cleanup();
  });
});

describe("both ProVideoPlayer progress rules are the same rule", () => {
  // The app draws this rule in TWO places off the same 1 Hz reading: the "now"
  // readout's `meter`, and the per-row rule in the layer list. Both stepped.
  // Fixing one and leaving the other is the mistake this repo makes most often —
  // the `endedAt` guard in one of three recorders, `.catch` in one of four — so
  // this renders both widgets and asserts the interpolating fill is what came
  // out, rather than trusting that the second one was remembered.
  const T = "2026-08-30T12:00:00.000Z";
  const AT = Date.parse(T);
  const layer: PvpLayerDTO = {
    uuid: "l1", name: "Graphics", index: 0, state: "video",
    mediaName: "loop_a.mp4", mediaUuid: "m1",
    lastCueName: null, lastCueUuid: null, nextCueName: null,
    hidden: false, muted: false, opacity: 1, playbackRate: 1,
    anchorElapsedSec: 10, durationSec: 20,
  };
  const status: PvpStatusDTO = { connected: true, layers: [layer], sampledAt: T };

  test("the readout's rule interpolates", () => {
    const { container } = render(
      <PvpNowObject config={{ showProgress: true }} status={status} now={AT} skewMs={0} />,
    );
    assert.equal(container.querySelectorAll(".su-meter-fill").length, 1);
    cleanup();
  });

  test("and so does the layer list's, which is a SEPARATE call site", () => {
    const { container } = render(
      <PvpObject
        config={{ type: "pvp-layers", show: "all", showProgress: true, hideWhenEmpty: false }}
        status={status}
        now={AT}
        skewMs={0}
        H={200}
      />,
    );
    const bar = container.querySelector("[data-pvp-bar]");
    assert.ok(bar, "the layer list drew no progress rule");
    assert.equal(
      bar.querySelectorAll(".su-meter-fill").length,
      1,
      "the layer list draws its own fill, so it still steps once a second",
    );
    cleanup();
  });
});

describe("a label never renders without the value it labels", () => {
  test("at every height, and with every combination of the extras", () => {
    // "remaining" with no number is worse than useless, and so is a rule with
    // nothing to be a fraction of. The drop order already puts the value last;
    // this asserts the consequence directly, because the order is easy to keep
    // while the value's own floor goes away underneath it.
    for (let box = 4; box <= 1200; box += 2) {
      for (const extras of [{}, { meter: true }, { footer: true }, { meter: true, footer: true }]) {
        for (const uniform of [false, true]) {
          const f = fitComposition(box, true, true, uniform, extras);
          const others = f.captionPx > 0 || f.subPx > 0 || f.meterPx > 0 || f.footerPx > 0;
          if (!others) continue;
          assert.ok(
            f.valuePx > 0,
            `${box}px box ${JSON.stringify(extras)}${uniform ? " uniform" : ""}: ` +
              `caption ${f.captionPx.toFixed(1)}, sub ${f.subPx.toFixed(1)}, ` +
              `rule ${f.meterPx.toFixed(1)}, footer ${f.footerPx.toFixed(1)} — ` +
              `and the value at ${f.valuePx.toFixed(1)}px`,
          );
        }
      }
    }
  });
});
