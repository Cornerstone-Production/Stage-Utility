// When a screen decides its slice of the horizon has changed.
//
// The horizon array keys an effect that writes the whole plan to the device and
// re-fetches every asset, so handing back a fresh array for an unchanged plan is
// real work on an SD card — and the server broadcasts on a change to ANY screen,
// so an unchanged screen receives those broadcasts too.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageHorizon } from "@main/types/signage";

import { sameHorizon } from "./use-signage-plan";

const h = (over: Record<string, unknown> = {}): SignageHorizon =>
  [{ from: 0, until: 9000, reason: "default", reasonLabel: "P", reasonId: "g1",
     playlist: { id: "p1", name: "P", startedAt: 0, fit: "contain",
                 transition: { kind: "cut", ms: 0 }, items: [] }, ...over }] as never;

describe("has this screen's horizon changed", () => {
  test("two structurally equal horizons are the same one", () => {
    // They arrive as fresh JSON on every broadcast, so a reference check would
    // always say "changed" and the guard would do nothing.
    assert.equal(sameHorizon(h(), h()), true);
  });

  test("a changed reason is a change", () => {
    assert.equal(sameHorizon(h(), h({ reason: "schedule" })), false);
  });

  test("a moved boundary is a change", () => {
    assert.equal(sameHorizon(h(), h({ until: 9001 })), false);
  });

  test("a changed startedAt is a change, because the wall restarts on it", () => {
    const moved = h();
    (moved[0].playlist as { startedAt: number }).startedAt = 5;
    assert.equal(sameHorizon(h(), moved), false);
  });

  test("two empty horizons are the same one", () => {
    assert.equal(sameHorizon([], []), true);
  });

  test("empty and non-empty differ", () => {
    assert.equal(sameHorizon([], h()), false);
  });
});
