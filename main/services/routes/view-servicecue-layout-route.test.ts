// PATCH /api/views/:id's ServiceCue column-preset field, driven through the real
// handler.
//
// The field is `serviceCueLayoutId`. Before ServiceCue was renamed it was
// `scriptViewLayoutId`, and the API reference told scripts to send that, so a
// script written against it must keep working: refused as "nothing to update"
// it would fail on the first call after an upgrade with no hint why.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-servicecue-layout-route-");

const layoutOf = () => stageController.getState().views.find((v) => v.id === "v1")?.serviceCueLayoutId;

beforeEach(() => {
  // The harness reseeds views before each test; give the view a preset to clear.
  const ctl = stageController as unknown as { state: { views: View[] } };
  ctl.state = { ...ctl.state, views: ctl.state.views.map((v) => ({ ...v, serviceCueLayoutId: "L1" })) };
});

describe("PATCH /api/views/:id — serviceCueLayoutId", () => {
  it("clears the preset by its current name", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { serviceCueLayoutId: null } });
    assert.equal(r.status, 200);
    assert.equal(layoutOf(), null);
  });

  it("clears the preset by its pre-rename name, scriptViewLayoutId", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { scriptViewLayoutId: null } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(layoutOf(), null);
  });

  it("prefers the current name when a body carries both", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v1", {
      method: "PATCH",
      body: { serviceCueLayoutId: null, scriptViewLayoutId: "L1" },
    });
    assert.equal(r.status, 200);
    assert.equal(layoutOf(), null);
  });

  it("still refuses a body that names neither, or a value that is not a string or null", async () => {
    const none = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: {} });
    assert.equal(none.status, 400);
    const bad = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { scriptViewLayoutId: 7 } });
    assert.equal(bad.status, 400);
    assert.equal(layoutOf(), "L1", "a refused body must change nothing");
  });
});
