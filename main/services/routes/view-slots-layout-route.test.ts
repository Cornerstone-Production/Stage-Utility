// PATCH /api/views/:id takes `slotsLayout` as an object or null, never an array.
//
// The route used to accept any `typeof "object"`, which an array is, so a list
// was stored where a layout belongs. A restore of views.json holds the field to
// the same predicate (isSlotsLayoutValue); this is the route's half.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-slotslayout-route-");

describe("PATCH /api/views/:id — slotsLayout", () => {
  it("refuses an array and stores nothing", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { slotsLayout: [1, 2] } });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(Array.isArray(stageController.getState().views.find((v) => v.id === "v1")?.slotsLayout), false);
  });

  it("still takes null", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { slotsLayout: null } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });
});
