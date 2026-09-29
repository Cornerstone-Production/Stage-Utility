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
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-output-unknown-id-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { viewRoutes } = await import("./view-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");

type Mutable = { state: { views: View[]; outputs: Output[]; [k: string]: unknown }; broadcast: () => void };
const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};

beforeEach(() => {
  ctl.state = {
    ...ctl.state,
    views: [{ id: "v1", name: "Mic board", kind: "slots", createdAt: "" }] as View[],
    outputs: [{ id: "wall", name: "Stage wall", viewId: "v1" }] as Output[],
  };
  (stageController as unknown as { recomputeResolved: () => void }).recomputeResolved();
});

const FIELDS: [name: string, body: Record<string, unknown>][] = [
  ["name", { name: "New Name" }],
  ["blackout", { blackout: true }],
  ["locked", { locked: true }],
  ["hideTopBar", { hideTopBar: true }],
  ["allowHls", { allowHls: false }],
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
