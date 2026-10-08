// PATCH /api/outputs/:id on an id that names no output, for every boolean flag
// the route accepts, and for `name`.
//
// setOutputView, setOutputMode and setOutputSlug were already wrapped here in a
// try/catch that turns a thrown "not found" into a clean 400 with the reason.
// setOutputBlackout, setOutputLocked, setOutputHideTopBar and setOutputAllowHls
// were not: each threw a plain Error the route let escape uncaught, which
// remote-server.ts's outer handler turns into a generic 500 — a worse response
// than the other three fields on the exact same endpoint get, for the exact
// same mistake (a stale or mistyped id). renameOutput (`name`) missed the same
// wrap and missed this very test file, so it kept answering 500 after the four
// below were fixed. This drives the real route for all five, so a sixth field
// added the same way is caught by the same shape.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-output-unknown-id-");

const FIELDS: [name: string, body: Record<string, unknown>][] = [
  ["name", { name: "New Name" }],
  ["blackout", { blackout: true }],
  ["locked", { locked: true }],
  ["hideTopBar", { hideTopBar: true }],
  ["allowHls", { allowHls: false }],
  ["groups", { groups: [] }],
  ["textSize", { textSize: 150 }],
];

describe("PATCH /api/outputs/:id — an unknown id, for every boolean flag and for name", () => {
  for (const [name, body] of FIELDS) {
    it(`${name}: answers 400 with the reason, not an uncaught throw`, async () => {
      const r = await callRoute(viewRoutes, "/api/outputs/nowhere", { method: "PATCH", body });
      assert.equal(r.status, 400, `${name}: expected a clean 400`);
      const message = (r.json as { error?: string })?.error ?? "";
      assert.match(message, /not found/i, `${name}: expected the reason in the body`);
    });
  }

  it("changes nothing on the real output when the id in the request is wrong", async () => {
    const before = stageController.getState().resolvedByOutput.wall;
    for (const [, body] of FIELDS) {
      await callRoute(viewRoutes, "/api/outputs/nowhere", { method: "PATCH", body });
    }
    assert.deepEqual(stageController.getState().resolvedByOutput.wall, before);
  });
});
