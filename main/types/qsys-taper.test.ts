// The Q-SYS taper: a fader's Position for a value, as a Core reports it.
//
// The measured points are written out here as literals, not read from the table,
// so a change to the table is a change to this file too. They were measured on
// Q-SYS Designer 10.0.1 in Emulate: a mixer's output gain (-100..+10 dB) and a
// Gain block's gain (-100..+20 dB), Position set, Value read.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MEASURED_TAPERS, kindText, positionOf, taperFor, untaperedRanges, valueOf } from "./qsys-taper.js";
import type { View } from "./views.js";

/** A mixer's output gain, -100..+10 dB, Value to Position, every 0.025 of travel as the Core reports it. */
const MEASURED_MIXER: [value: number, position: number][] = [
  [-100, 0],
  [-87.5, 0.025],
  [-75, 0.05],
  [-62.5, 0.075],
  [-50, 0.1],
  [-46.034, 0.125],
  [-42.308, 0.15],
  [-38.813, 0.175],
  [-35.538, 0.2],
  [-32.476, 0.225],
  [-29.615, 0.25],
  [-26.947, 0.275],
  [-24.462, 0.3],
  [-22.149, 0.325],
  [-20, 0.35],
  [-18.005, 0.375],
  [-16.154, 0.4],
  [-14.437, 0.425],
  [-12.846, 0.45],
  [-11.37, 0.475],
  [-10, 0.5],
  [-8.726, 0.525],
  [-7.538, 0.55],
  [-6.428, 0.575],
  [-5.385, 0.6],
  [-4.399, 0.625],
  [-3.462, 0.65],
  [-2.562, 0.675],
  [-1.692, 0.7],
  [-0.841, 0.725],
  [0, 0.75],
  [0.841, 0.775],
  [1.692, 0.8],
  [2.562, 0.825],
  [3.462, 0.85],
  [4.399, 0.875],
  [5.385, 0.9],
  [6.428, 0.925],
  [7.538, 0.95],
  [8.726, 0.975],
  [10, 1],
];

describe("the measured tapers", () => {
  test("the kinds measured, one per line, sorted", () => {
    assert.deepEqual(MEASURED_TAPERS.map(kindText), ["gain -100..20", "mixer -100..10"]);
  });

  test("a mixer -100..+10 control sits where a Core puts it at every measured point, both ways", () => {
    const t = taperFor("mixer", { min: -100, max: 10 })!;
    for (const [v, p] of MEASURED_MIXER) {
      assert.ok(Math.abs(positionOf(t, v) - p) < 1e-12, `${v} dB is at ${positionOf(t, v)}, the Core says ${p}`);
      assert.ok(Math.abs(valueOf(t, p) - v) < 1e-9, `${p} is ${valueOf(t, p)} dB, the Core says ${v}`);
    }
    assert.equal(positionOf(t, -20), 0.35);
    assert.equal(positionOf(t, -50), 0.1);
    assert.equal(positionOf(t, 0), 0.75);
  });

  test("a Gain block -100..+20 control is linear, both ways", () => {
    const t = taperFor("gain", { min: -100, max: 20 })!;
    for (let p = 0; p <= 1.0000001; p += 0.025) {
      const v = -100 + 120 * p;
      assert.ok(Math.abs(positionOf(t, v) - p) < 1e-9, `${v} dB is at ${positionOf(t, v)}, not ${p}`);
      assert.ok(Math.abs(valueOf(t, p) - v) < 1e-9, `${p} is ${valueOf(t, p)} dB, not ${v}`);
    }
    assert.ok(Math.abs(positionOf(t, 0) - 100 / 120) < 1e-12, "0 dB is at 0.8333");
  });

  test("between the points it is monotone and round-trips; past the ends it holds at them", () => {
    for (const t of MEASURED_TAPERS) {
      let last = -Infinity;
      for (let v = t.min; v <= t.max; v += 0.25) {
        const p = positionOf(t, v);
        assert.ok(p >= last, `${kindText(t)}: ${v} dB goes back down the travel`);
        last = p;
        assert.ok(Math.abs(valueOf(t, p) - v) < 1e-9, `${kindText(t)}: ${v} dB does not round-trip`);
      }
      assert.equal(positionOf(t, t.min - 50), 0);
      assert.equal(positionOf(t, t.max + 50), 1);
      assert.equal(valueOf(t, -1), t.min);
      assert.equal(valueOf(t, 2), t.max);
    }
  });

  test("a value or a place that is not a number reads as the bottom, never the top", () => {
    for (const t of MEASURED_TAPERS) {
      assert.equal(positionOf(t, Number.NaN), 0, `${kindText(t)}: NaN dB is not at the bottom of the travel`);
      assert.equal(valueOf(t, Number.NaN), t.min, `${kindText(t)}: a NaN place is not the bottom value`);
    }
  });

  test("only an exact component type and range has a taper: a Gain block on the mixer's range gets none", () => {
    assert.ok(taperFor("mixer", { min: -100, max: 10 }));
    assert.ok(taperFor("gain", { min: -100, max: 20 }));
    assert.equal(taperFor("gain", { min: -100, max: 10 }), null, "a Gain block on -100..10 is linear, not the mixer's curve");
    assert.equal(taperFor("mixer", { min: -100, max: 20 }), null);
    assert.equal(taperFor("mixer", { min: -100, max: 12 }), null);
    assert.equal(taperFor(null, { min: -100, max: 10 }), null);
    assert.equal(taperFor("", { min: -100, max: 10 }), null);
    assert.equal(taperFor("mixer", null), null);
  });
});

describe("untaperedRanges", () => {
  const view = (id: string, objects: unknown[]): View => ({ id, name: id, kind: "custom", layout: { version: 1, canvas: {}, objects } }) as never as View;
  const o = (id: string, config: unknown) => ({ id, x: 0, y: 0, w: 0.1, h: 0.1, z: 1, config });
  const catalog = {
    components: [
      {
        name: "Lobby_Mixer",
        type: "mixer",
        controls: [
          { Name: "output.1.gain", ValueMin: -100, ValueMax: 10 },
          { Name: "output.2.gain", ValueMin: -100, ValueMax: 20 },
          { Name: "input.1.gain", ValueMin: -100, ValueMax: 20 },
          { Name: "trim", ValueMin: -12, ValueMax: 12 },
          { Name: "meter.1", ValueMin: -120, ValueMax: 20 },
        ],
      },
      // A Gain block: -100..20 is measured; -100..10 is the mixer's range, not its own.
      { name: "Lobby_Gain", type: "gain", controls: [{ Name: "gain", ValueMin: -100, ValueMax: 20 }] },
      { name: "Hall_Gain", type: "gain", controls: [{ Name: "gain", ValueMin: -100, ValueMax: 10 }] },
    ],
  };
  test("the fader and strip-level ranges with no table for their component type, each control once, sorted; meters, measured ranges and unknown controls are not listed", () => {
    const fader = (control: string) => ({ type: "qsys-fader", binding: { component: "Lobby_Mixer", control }, orientation: "vertical", showDb: true, steps: false, stepDb: 1 });
    const views = [
      view("a", [o("1", fader("output.1.gain")), o("2", fader("output.2.gain")), o("3", fader("gone")), o("4", { type: "qsys-meter", binding: { component: "Lobby_Mixer", control: "meter.1" }, form: "bar" })]),
      view("b", [
        o("5", { type: "qsys-strip", name: null, label: "", gain: { component: "Lobby_Mixer", control: "input.1.gain" }, mute: null, meter: null }),
        o("6", fader("output.2.gain")),
        o("7", fader("trim")),
        o("8", { type: "qsys-fader", binding: { component: "Lobby_Gain", control: "gain" }, orientation: "vertical", showDb: true, steps: false, stepDb: 1 }),
        o("9", { type: "qsys-fader", binding: { component: "Hall_Gain", control: "gain" }, orientation: "vertical", showDb: true, steps: false, stepDb: 1 }),
      ]),
    ];
    assert.deepEqual(untaperedRanges(views, catalog), [
      { type: "gain", min: -100, max: 10, controls: [{ component: "Hall_Gain", control: "gain" }] },
      { type: "mixer", min: -100, max: 20, controls: [{ component: "Lobby_Mixer", control: "input.1.gain" }, { component: "Lobby_Mixer", control: "output.2.gain" }] },
      { type: "mixer", min: -12, max: 12, controls: [{ component: "Lobby_Mixer", control: "trim" }] },
    ]);
  });
});
