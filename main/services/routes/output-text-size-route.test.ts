// PATCH /api/outputs/:id's `textSize` field, driven through the real handler.
//
// The controller-level behaviour (persistence, range, not rewriting an unchanged
// size) is main/services/output-text-size.test.ts. This is the HTTP boundary: the
// round trip a display makes (PATCH, then the state every client gets carries the
// size), and the 400 a junk or out-of-range value gets rather than being ignored.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-textsize-route-");

type PatchResponse = { outputs: Output[]; resolvedByOutput: Record<string, { textSize: number | null }> };

describe("PATCH /api/outputs/:id — textSize", () => {
  it("keeps the size: the response, and the state every client gets next, carry it", async () => {
    const r = await callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body: { textSize: 150 } });
    assert.equal(r.status, 200);
    const body = r.json as PatchResponse;
    assert.equal(body.outputs.find((o) => o.id === "wall")?.textSize, 150);
    assert.equal(body.resolvedByOutput.wall?.textSize, 150, "the resolved descriptor a display and its previews read");
    assert.equal(stageController.getState().resolvedByOutput.wall?.textSize, 150, "the state the next client gets");
  });

  it("refuses a size outside 50 to 300, or not a number, with a 400 that says why, and changes nothing", async () => {
    await callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body: { textSize: 120 } });
    for (const bad of [49, 301, "150", null, true, [150], {}]) {
      const r = await callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body: { textSize: bad } });
      assert.equal(r.status, 400, `textSize ${JSON.stringify(bad)} was accepted`);
      assert.match((r.json as { error?: string })?.error ?? "", /textSize must be a number from 50 to 300/);
    }
    assert.equal(stageController.getState().resolvedByOutput.wall?.textSize, 120);
  });

  it("combines with the other output fields in one request", async () => {
    const r = await callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body: { textSize: 90, locked: true } });
    assert.equal(r.status, 200);
    const wall = (r.json as PatchResponse).outputs.find((o) => o.id === "wall");
    assert.deepEqual({ textSize: wall?.textSize, locked: wall?.locked }, { textSize: 90, locked: true });
  });
});
