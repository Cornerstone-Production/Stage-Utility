import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync, existsSync } from "node:fs";

import { resolveLayout } from "./responsive-layout.js";

// The claim that lets this ship: with nothing configured, responsive lays every
// object out exactly where proportional fractions already put it.
//
// Asserted against REAL LAYOUTS, not fixtures. A model that is a no-op on a
// two-object test case and moves a real 40-object stage layout by three pixels
// is still a regression — and the operator would find it, not the suite.
//
// Reads a config copy if one is present (the developer's own, copied to /tmp),
// and falls back to a synthetic layout that exercises the same shapes. It never
// reads ~/.stage-utility: tests must not touch the real config.

const CANDIDATES = ["/tmp/phase3-config/views.json", "/tmp/stage-live-copy/views.json"];

function realLayouts(): { name: string; layout: LayoutDTO }[] {
  for (const path of CANDIDATES) {
    if (!existsSync(path)) continue;
    const views = JSON.parse(readFileSync(path, "utf8")) as View[];
    const withLayouts = views
      .filter((v) => v.layout?.objects?.length)
      .map((v) => ({ name: v.name, layout: v.layout as LayoutDTO }));
    if (withLayouts.length) return withLayouts;
  }
  return [];
}

/** What the old proportional model produced: fractions of the box, no more. */
function proportional(objects: readonly LayoutObject[], box: { left: number; top: number; w: number; h: number }) {
  const out: { id: string; left: number; top: number; width: number; height: number }[] = [];
  for (const o of objects) {
    const r = { left: box.left + o.x * box.w, top: box.top + o.y * box.h, width: o.w * box.w, height: o.h * box.h };
    out.push({ id: o.id, ...r });
    // The child's box uses w/h, not width/height. Passing the wrong shape made
    // every nested object NaN and reported the model as broken when it was this
    // reference that was.
    if (o.children?.length) {
      out.push(...proportional(o.children, { left: r.left, top: r.top, w: r.width, h: r.height }));
    }
  }
  return out;
}

const VIEWPORTS = [
  { w: 1920, h: 1080, label: "the design shape" },
  { w: 1440, h: 900, label: "a laptop" },
  { w: 1280, h: 800, label: "a smaller laptop" },
];

describe("responsive is a no-op on real layouts", () => {
  const layouts = realLayouts();

  test("found layouts to check, or said so", () => {
    // A test that silently checks nothing is worse than no test. If there is no
    // config copy this reports it rather than passing quietly.
    if (layouts.length === 0) {
      console.log("    (no config copy present — synthetic check only)");
    }
    assert.ok(true);
  });

  for (const vp of VIEWPORTS) {
    test(`every object lands where it does today at ${vp.label}`, () => {
      const all = layouts.length
        ? layouts
        : [{
            name: "synthetic",
            layout: {
              version: 1, canvas: { width: 1920, height: 1080, background: null },
              objects: [
                { id: "a", x: 0.05, y: 0.1, w: 0.4, h: 0.3, z: 0, config: { type: "text" } },
                { id: "c", x: 0.5, y: 0.1, w: 0.45, h: 0.8, z: 1, config: { type: "container" },
                  children: [{ id: "n", x: 0.1, y: 0.1, w: 0.8, h: 0.4, z: 0, config: { type: "clock" } }] },
              ],
            } as unknown as LayoutDTO,
          }];

      for (const { name, layout } of all) {
        const got = resolveLayout(layout.objects, layout.canvas, vp);
        const want = proportional(layout.objects, { left: 0, top: 0, w: vp.w, h: vp.h });
        assert.equal(got.length, want.length, `${name}: object count changed`);
        for (const w of want) {
          const g = got.find((x) => x.id === w.id)!;
          assert.ok(g, `${name}: object ${w.id} vanished`);
          for (const k of ["left", "top", "width", "height"] as const) {
            assert.ok(
              Math.abs(g[k] - w[k]) < 1,
              `${name}: ${w.id}.${k} moved from ${w[k].toFixed(2)} to ${g[k].toFixed(2)}`,
            );
          }
        }
      }
    });
  }
});
