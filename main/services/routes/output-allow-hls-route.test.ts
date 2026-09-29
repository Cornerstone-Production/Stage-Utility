// PATCH /api/outputs/:id's `allowHls` field, driven through the real handler.
//
// The controller-level behaviour (persistence, defaulting, independence from
// the other output flags) is main/services/output-allow-hls.test.ts. This file
// is the HTTP boundary alone: the body the route accepts, the 400 it gives a
// malformed one, and that a successful PATCH hands back a display that would
// actually read the change — the resolved descriptor the kiosk reads, not just
// the raw Output the request patched.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-allowhls-route-"));
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

type PatchResponse = { outputs: Output[]; resolvedByOutput: Record<string, { allowHls: boolean }> };

describe("PATCH /api/outputs/:id — allowHls", () => {
  it("accepts false, and the response's own resolved descriptor carries it", async () => {
    const r = await callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body: { allowHls: false } });
    assert.equal(r.status, 200);
    const body = r.json as PatchResponse;
    assert.equal(body.outputs.find((o) => o.id === "wall")?.allowHls, false, "the raw Output must carry the new value");
    assert.equal(
      body.resolvedByOutput.wall?.allowHls,
      false,
      "the response must hand back the RESOLVED descriptor a kiosk actually reads, already reflecting the change",
    );
  });

  it("accepts true, turning it back on", async () => {
    await callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body: { allowHls: false } });
    const r = await callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body: { allowHls: true } });
    assert.equal(r.status, 200);
    const body = r.json as PatchResponse;
    assert.equal(body.resolvedByOutput.wall?.allowHls, true);
  });

  it("refuses a non-boolean value with a 400, and changes nothing", async () => {
    const r = await callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body: { allowHls: "off" } });
    assert.equal(r.status, 400);
    assert.ok((r.json as { error: string })?.error?.length > 0, "a refused body must say why");

    const state = stageController.getState();
    assert.equal(
      state.resolvedByOutput.wall?.allowHls,
      true,
      "a rejected request must not have flipped the output's HLS setting",
    );
  });

  it("refuses an id that names no output with a clean 400 — same as hideTopBar, locked and blackout", async () => {
    // See output-patch-unknown-id.test.ts for all four fields together; this
    // just confirms allowHls's own request goes through the same caught shape.
    const r = await callRoute(viewRoutes, "/api/outputs/nowhere", { method: "PATCH", body: { allowHls: false } });
    assert.equal(r.status, 400);
    assert.match((r.json as { error?: string })?.error ?? "", /not found/i);
  });

  it("combines with the other output flags in one request, same as hideTopBar does", async () => {
    const r = await callRoute(viewRoutes, "/api/outputs/wall", {
      method: "PATCH",
      body: { allowHls: false, hideTopBar: true, locked: true },
    });
    assert.equal(r.status, 200);
    const body = r.json as PatchResponse & { outputs: (Output & { hideTopBar?: boolean; locked?: boolean })[] };
    const wall = body.outputs.find((o) => o.id === "wall");
    assert.deepEqual(
      { allowHls: wall?.allowHls, hideTopBar: wall?.hideTopBar, locked: wall?.locked },
      { allowHls: false, hideTopBar: true, locked: true },
    );
  });
});
