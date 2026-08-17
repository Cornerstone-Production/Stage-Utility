import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { collectRefs } from "./view-refs.js";
import type { View, LayoutObject } from "../types/views.js";

// Export is only as good as this walk: a reference it misses is a hole in the
// imported layout, and one it invents is a file that will not build.

const obj = (id: string, config: Record<string, unknown>): LayoutObject =>
  ({ id, x: 0, y: 0, w: 10, h: 10, z: 0, style: {}, config }) as unknown as LayoutObject;

const view = (id: string, objects: LayoutObject[]): View =>
  ({
    id, name: id, kind: "custom", createdAt: 0,
    layout: { version: 1, canvas: { w: 1920, h: 1080 }, objects },
  }) as unknown as View;

describe("what a view points at", () => {
  test("an embedded view is collected", () => {
    const a = view("view-1", [obj("o1", { type: "view-embed", viewId: "view-2" })]);
    const b = view("view-2", []);
    assert.deepEqual(collectRefs([a, b], "view-1").embeddedViewIds, ["view-2"]);
  });

  test("embedding is followed transitively, and never loops", () => {
    // A cycle is possible to author and must not hang the export.
    const a = view("view-1", [obj("o1", { type: "view-embed", viewId: "view-2" })]);
    const b = view("view-2", [obj("o2", { type: "view-embed", viewId: "view-1" })]);
    assert.deepEqual(collectRefs([a, b], "view-1").embeddedViewIds, ["view-2"]);
  });

  test("a slots-grid sourcing another view counts as embedding it", () => {
    const a = view("view-1", [
      obj("o1", { type: "slots-grid", source: "view", sourceViewId: "view-9" }),
    ]);
    assert.deepEqual(collectRefs([a, view("view-9", [])], "view-1").embeddedViewIds, ["view-9"]);
  });

  test("nested container children are walked", () => {
    const child = obj("deep", { type: "image", src: "/layout-images/abc.png" });
    const parent = { ...obj("box", { type: "container" }), children: [child] } as LayoutObject;
    const r = collectRefs([view("view-1", [parent])], "view-1");
    assert.deepEqual(r.imageFiles, ["layout-images/abc.png"]);
    assert.ok(r.objectIds.includes("deep"), "a child object was not collected");
  });

  test("targets are collected by id", () => {
    const v = view("view-1", [
      obj("o1", { type: "osc-button", targetId: "osc-a", address: "/x", args: [] }),
      obj("o2", { type: "rosstalk-button", targetId: "ross-a", commandId: "cut" }),
    ]);
    const r = collectRefs([v], "view-1");
    assert.deepEqual(r.oscTargetIds, ["osc-a"]);
    assert.deepEqual(r.rosstalkTargetIds, ["ross-a"]);
  });

  test("hardware bindings land in the rebind list, not silently dropped", () => {
    const v = view("view-1", [
      obj("o1", { type: "wireless-channel", channelId: "conn-7::3", label: "Handheld 3" }),
      obj("o2", { type: "spl-meter", meterId: "FOH::Main", metricKey: "spl" }),
    ]);
    const kinds = collectRefs([v], "view-1").unresolvable.map((u) => u.kind).sort();
    assert.deepEqual(kinds, ["spl", "wireless"]);
  });

  test("integration status and the primary ProPresenter are NOT rebind work", () => {
    // Their ids are fixed constants and "default" — they resolve on any install
    // that has the integration configured, so listing them would be noise.
    const v = view("view-1", [
      obj("o1", { type: "integration-status", integrationId: "obs" }),
      obj("o2", { type: "propresenter-slide", propresenterInstanceId: "default" }),
    ]);
    assert.deepEqual(collectRefs([v], "view-1").unresolvable, []);
  });
});
