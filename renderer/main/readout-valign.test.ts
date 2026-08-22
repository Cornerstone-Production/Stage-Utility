// The alignment pad has nine cells. Three of them worked.
//
// The readout composition paints over the object's box absolutely, and it had
// `justifyContent: center` written into it — so the pad's top and bottom rows
// were saved, reloaded, and ignored by every widget that uses the idiom, which
// is most of them. Reported as "only left, center and right actually work".

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { boxStyle } from "./layout-renderer.js";
import type { LayoutObject } from "@main/types/views.js";

const READOUT = readFileSync(new URL("./readout.tsx", import.meta.url), "utf8");

const obj = (vAlign?: "top" | "middle" | "bottom"): LayoutObject =>
  ({ id: "x", x: 0, y: 0, w: 0.3, h: 0.2, z: 1, style: vAlign ? { vAlign } : {}, config: { type: "clock" } }) as LayoutObject;

const varOf = (o: LayoutObject) =>
  (boxStyle(o, 1080) as Record<string, unknown>)["--readout-v-align"];

describe("vertical alignment reaches the composition", () => {
  test("each row of the pad publishes its own value", () => {
    assert.equal(varOf(obj("top")), "flex-start");
    assert.equal(varOf(obj("middle")), "center");
    assert.equal(varOf(obj("bottom")), "flex-end");
  });

  test("an object that never set one publishes nothing", () => {
    // So the composition's own default stands, rather than every widget being
    // pinned to centre by a property nobody asked for.
    assert.equal(varOf(obj()), undefined);
  });

  test("the composition reads it, and still centres when it is absent", () => {
    // The consuming half. Hard-code `center` again and this goes red — which is
    // the exact defect: a control that saves and does nothing.
    assert.match(
      READOUT,
      /justifyContent: "var\(--readout-v-align, center\)"/,
      "the readout no longer takes the object's vertical alignment",
    );
  });
});
