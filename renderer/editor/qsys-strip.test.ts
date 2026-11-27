// The channel strip's one-step bind and break-apart, as pure functions.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { breakApartStrip, channelsOf, matchStrip, STRIP_TEMPLATES, type Eligibility } from "./qsys-strip.js";
import { isMeterControl } from "@main/types/qsys";
import type { LayoutObject } from "@main/types/views";

const NAMES = ["input_3_gain", "input_3_mute", "meter_3", "text_display_3", "input_4_gain", "output_1_gain", "output_1_mute", "meter_output_1", "noise"];
const allow: Eligibility = () => "ok";

describe("the strip's name table", () => {
  test("templates are one per line, and each slot's lines are sorted", () => {
    const bySlot = new Map<string, string[]>();
    for (const t of STRIP_TEMPLATES) bySlot.set(t.slot, [...(bySlot.get(t.slot) ?? []), t.template]);
    for (const [slot, list] of bySlot) assert.deepEqual(list, [...list].sort(), `${slot} templates are not sorted`);
    assert.equal(new Set(STRIP_TEMPLATES.map((t) => t.template)).size, STRIP_TEMPLATES.length, "a template is listed twice");
  });
});

describe("the meter templates", () => {
  test("every name they make is one the Core browser's meter rule accepts", () => {
    for (const t of STRIP_TEMPLATES.filter((x) => x.slot === "meter" || x.slot === "meter2")) {
      for (const side of ["input", "output"]) {
        const name = t.template.replace("{s}", side).replace("{n}", "3");
        assert.equal(isMeterControl("mixer", { Name: name, Type: "Float" }), true, `${name} would be filled but not offered by the Meter field`);
      }
    }
  });
});

describe("channelsOf", () => {
  test("finds each channel once, sided before unsided, and folds an unsided meter into its sided channel", () => {
    assert.deepEqual(channelsOf(NAMES), [
      { side: "input", n: 3 },
      { side: "input", n: 4 },
      { side: "output", n: 1 },
    ]);
  });
  test("a channel known only by number is its own", () => {
    assert.deepEqual(channelsOf(["meter_7", "mute_7", "unrelated"]), [{ side: "", n: 7 }]);
  });
});

describe("matchStrip", () => {
  test("fills every slot from the names a channel follows", () => {
    const m = matchStrip(NAMES, { side: "input", n: 3 }, allow);
    assert.deepEqual(
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.control])),
      { gain: "input_3_gain", meter: "meter_3", meter2: null, mute: "input_3_mute", name: "text_display_3" },
    );
    assert.equal(m.meter2.problem, "missing");
  });
  test("an output channel reads its own names", () => {
    const m = matchStrip(NAMES, { side: "output", n: 1 }, allow);
    assert.deepEqual([m.gain.control, m.mute.control, m.meter.control], ["output_1_gain", "output_1_mute", "meter_output_1"]);
  });
  test("a write slot with a control that is not eligible stays empty and says why; a read slot is unaffected", () => {
    const eligible: Eligibility = (slot, name) => (slot === "gain" ? "not-allowed" : slot === "mute" && name === "input_3_mute" ? "not-writable" : "ok");
    const m = matchStrip(NAMES, { side: "input", n: 3 }, eligible);
    assert.deepEqual([m.gain.control, m.gain.problem], [null, "not-allowed"]);
    assert.deepEqual([m.mute.control, m.mute.problem], [null, "not-writable"]);
    assert.equal(m.meter.control, "meter_3", "a read slot needs no allowlist");
  });
  test("an eligible later template wins over an ineligible earlier one", () => {
    const names = ["input_3_gain", "gain_3"];
    const m = matchStrip(names, { side: "input", n: 3 }, (_s, name) => (name === "input_3_gain" ? "not-allowed" : "ok"));
    assert.equal(m.gain.control, "gain_3");
  });
  test("a channel number does not match a longer one (input_3 is not input_30)", () => {
    const m = matchStrip(["input_30_gain"], { side: "input", n: 3 }, allow);
    assert.equal(m.gain.control, null);
  });
});

const strip = (over: Record<string, unknown> = {}): LayoutObject =>
  ({
    id: "s1",
    x: 0.2,
    y: 0.1,
    w: 0.1,
    h: 0.8,
    z: 3,
    style: { background: "x" },
    config: { type: "qsys-strip", name: { component: "C", control: "name" }, label: "", gain: { component: "C", control: "gain", indicator: null }, mute: { component: "C", control: "mute" }, meter: { component: "C", control: "m1" }, meter2: { component: "C", control: "m2" }, density: "dense", ...over },
  }) as never;

describe("breakApartStrip", () => {
  test("replaces a strip with label, fader, meter and mute in its footprint, keeping bindings and density", () => {
    let n = 0;
    const parts = breakApartStrip(strip(), () => `n${n++}`);
    assert.deepEqual(parts.map((p) => p.config.type), ["qsys-label", "qsys-fader", "qsys-meter", "qsys-mute"]);
    const c = parts.map((p) => p.config as never as Record<string, unknown>);
    assert.deepEqual(c[0]!.binding, { component: "C", control: "name" });
    assert.deepEqual(c[1]!.binding, { component: "C", control: "gain", indicator: null });
    assert.equal(c[1]!.density, "dense");
    assert.deepEqual([c[2]!.binding, c[2]!.binding2], [{ component: "C", control: "m1" }, { component: "C", control: "m2" }]);
    assert.deepEqual(c[3]!.binding, { component: "C", control: "mute" });
    // Together they cover exactly the strip's box, with no overlap.
    const area = parts.reduce((a, p) => a + p.w * p.h, 0);
    assert.ok(Math.abs(area - 0.1 * 0.8) < 1e-9, `area ${area}`);
    for (const p of parts) {
      assert.ok(p.x >= 0.2 - 1e-9 && p.x + p.w <= 0.3 + 1e-9 && p.y >= 0.1 - 1e-9 && p.y + p.h <= 0.9 + 1e-9, "a part leaves the footprint");
      assert.equal(p.style!.background, "x", "style carries over");
      assert.equal(p.z, 3);
    }
    assert.deepEqual(new Set(parts.map((p) => p.id)).size, 4, "ids are fresh");
  });
  test("the label is sized to read across the strip, and the other parts keep the strip's style", () => {
    const wide = breakApartStrip({ ...strip(), style: { fontSize: 0.05 } } as LayoutObject, (() => { let i = 0; return () => `l${i++}`; })());
    const label = wide[0]!;
    assert.ok((label.style!.fontSize ?? 1) < 0.05, `label kept the strip's ${label.style!.fontSize}`);
    // ten characters at 0.6 em, with padding, across the strip's width (0.1 of a 16:9 canvas)
    assert.ok(label.style!.fontSize! * 9 <= 0.1 * (16 / 9) + 1e-9, `label ${label.style!.fontSize} does not fit one line`);
    assert.ok(label.style!.fontSize! >= 0.012);
    assert.equal(wide[1]!.style!.fontSize, 0.05, "the fader scales from the strip's size");
    // a narrower strip gets a smaller label
    const narrow = breakApartStrip({ ...strip(), w: 0.05 }, () => `n${Math.random()}`)[0]!;
    assert.ok(narrow.style!.fontSize! < label.style!.fontSize!);
  });

  test("keepAspect, minPx and maxPx are not copied onto parts; anchor is", () => {
    const o = { ...strip(), keepAspect: true, minPx: { w: 80 }, maxPx: { h: 900 }, anchor: { x: "left", y: "top" } } as never as LayoutObject;
    for (const p of breakApartStrip(o, () => `a${Math.random()}`)) {
      assert.equal(p.keepAspect, undefined);
      assert.equal(p.minPx, undefined);
      assert.equal(p.maxPx, undefined);
      assert.deepEqual(p.anchor, { x: "left", y: "top" });
    }
  });

  test("a second meter with no first still becomes a meter part", () => {
    const parts = breakApartStrip(strip({ meter: null, meter2: { component: "C", control: "m2" } }), () => `m${Math.random()}`);
    const meter = parts.find((p) => p.config.type === "qsys-meter")!;
    assert.deepEqual((meter.config as never as Record<string, unknown>).binding, { component: "C", control: "m2" });
    assert.equal((meter.config as never as Record<string, unknown>).binding2, undefined);
  });

  test("a part the strip had nothing for is left out, and the rest fill the box", () => {
    const parts = breakApartStrip(strip({ name: null, mute: null, meter: null, meter2: null }), () => "x" + Math.random());
    assert.deepEqual(parts.map((p) => p.config.type), ["qsys-fader"]);
    assert.deepEqual([parts[0]!.x, parts[0]!.y, parts[0]!.w, parts[0]!.h], [0.2, 0.1, 0.1, 0.8]);
  });
});
