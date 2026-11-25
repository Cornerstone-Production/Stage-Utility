// The Q-SYS taper: a fader's Position for a value, as a Core reports it.
//
// The measured points are written out here as literals, not read from the table,
// so a change to the table is a change to this file too. They were measured on
// Q-SYS Designer 10.0.1 in Emulate: a mixer's output gain (-100..+10 dB), Value
// set, Position read.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MEASURED_TAPERS, positionOf, rangeText, taperFor, untaperedRanges, valueOf } from "./qsys-taper.js";
import type { View } from "./views.js";

const MEASURED_GAIN: [value: number, position: number][] = [
  [-100, 0],
  [-60, 0.08],
  [-40, 0.166],
  [-30, 0.247],
  [-20, 0.35],
  [-10, 0.5],
  [-6, 0.585],
  [-3, 0.663],
  [0, 0.75],
  [3, 0.837],
  [6, 0.915],
  [10, 1],
];

describe("the measured tapers", () => {
  test("the ranges measured, one per line, sorted", () => {
    assert.deepEqual(MEASURED_TAPERS.map(rangeText), ["-100..10"]);
  });

  test("a -100..+10 control sits where a Core puts it at every measured point, both ways", () => {
    const t = taperFor({ min: -100, max: 10 })!;
    for (const [v, p] of MEASURED_GAIN) {
      assert.ok(Math.abs(positionOf(t, v) - p) < 1e-12, `${v} dB is at ${positionOf(t, v)}, the Core says ${p}`);
      assert.ok(Math.abs(valueOf(t, p) - v) < 1e-9, `${p} is ${valueOf(t, p)} dB, the Core says ${v}`);
    }
  });

  test("between the points it is monotone and round-trips; past the ends it holds at them", () => {
    for (const t of MEASURED_TAPERS) {
      let last = -Infinity;
      for (let v = t.min; v <= t.max; v += 0.25) {
        const p = positionOf(t, v);
        assert.ok(p >= last, `${rangeText(t)}: ${v} dB goes back down the travel`);
        last = p;
        assert.ok(Math.abs(valueOf(t, p) - v) < 1e-9, `${rangeText(t)}: ${v} dB does not round-trip`);
      }
      assert.equal(positionOf(t, t.min - 50), 0);
      assert.equal(positionOf(t, t.max + 50), 1);
      assert.equal(valueOf(t, -1), t.min);
      assert.equal(valueOf(t, 2), t.max);
    }
  });

  test("only an exact range has a taper", () => {
    assert.ok(taperFor({ min: -100, max: 10 }));
    assert.equal(taperFor({ min: -100, max: 20 }), null);
    assert.equal(taperFor({ min: -100, max: 12 }), null);
    assert.equal(taperFor(null), null);
  });
});

describe("untaperedRanges", () => {
  const view = (id: string, objects: unknown[]): View => ({ id, name: id, kind: "custom", layout: { version: 1, canvas: {}, objects } }) as never as View;
  const o = (id: string, config: unknown) => ({ id, x: 0, y: 0, w: 0.1, h: 0.1, z: 1, config });
  const catalog = {
    components: [
      {
        name: "Lobby_Mixer",
        controls: [
          { Name: "output.1.gain", ValueMin: -100, ValueMax: 10 },
          { Name: "output.2.gain", ValueMin: -100, ValueMax: 20 },
          { Name: "input.1.gain", ValueMin: -100, ValueMax: 20 },
          { Name: "trim", ValueMin: -12, ValueMax: 12 },
          { Name: "meter.1", ValueMin: -120, ValueMax: 20 },
        ],
      },
    ],
  };
  test("the fader and strip-level ranges with no table, each control once, sorted; meters, measured ranges and unknown controls are not listed", () => {
    const fader = (control: string) => ({ type: "qsys-fader", binding: { component: "Lobby_Mixer", control }, orientation: "vertical", showDb: true, steps: false, stepDb: 1 });
    const views = [
      view("a", [o("1", fader("output.1.gain")), o("2", fader("output.2.gain")), o("3", fader("gone")), o("4", { type: "qsys-meter", binding: { component: "Lobby_Mixer", control: "meter.1" }, form: "bar" })]),
      view("b", [
        o("5", { type: "qsys-strip", name: null, label: "", gain: { component: "Lobby_Mixer", control: "input.1.gain" }, mute: null, meter: null }),
        o("6", fader("output.2.gain")),
        o("7", fader("trim")),
      ]),
    ];
    assert.deepEqual(untaperedRanges(views, catalog), [
      { min: -100, max: 20, controls: [{ component: "Lobby_Mixer", control: "input.1.gain" }, { component: "Lobby_Mixer", control: "output.2.gain" }] },
      { min: -12, max: 12, controls: [{ component: "Lobby_Mixer", control: "trim" }] },
    ]);
  });
});
