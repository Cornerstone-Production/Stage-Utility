// PATCH /api/outputs/:id's `groups` field, driven through the real handler.
//
// The controller-level behaviour (persistence, ordering, the one-write strip) is
// main/services/output-groups.test.ts. This file is the HTTP boundary alone: the
// body the route accepts, the 400 it gives a malformed or unknown one, and that
// a successful PATCH hands back the resolved descriptor a kiosk reads. An id
// naming no display is output-patch-unknown-id.test.ts's, for every field.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-groups-route-");
// After the harness: it points the data directory first.
const { messagingStore } = await import("../messaging-store.js");

type PatchResponse = { outputs: Output[]; resolvedByOutput: Record<string, { groups: string[] }> };

let green = "";
let stage = "";

beforeEach(async () => {
  const { config } = await messagingStore.replace({
    groups: [{ name: "Green room" }, { name: "Stage" }],
    quickMessages: [],
    quickReplies: [],
  });
  [green, stage] = config.groups.map((g) => g.id);
});

const patch = (body: unknown) => callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body });

describe("PATCH /api/outputs/:id — groups", () => {
  it("accepts a list of group ids, and the response's own resolved descriptor carries it", async () => {
    const r = await patch({ groups: [stage] });
    assert.equal(r.status, 200);
    const body = r.json as PatchResponse;
    assert.deepEqual(body.outputs.find((o) => o.id === "wall")?.groups, [stage], "the raw Output must carry the groups");
    assert.deepEqual(
      body.resolvedByOutput.wall?.groups,
      [stage],
      "the response must hand back the RESOLVED descriptor a kiosk actually reads",
    );
  });

  it("accepts an empty list, leaving every group", async () => {
    await patch({ groups: [green, stage] });
    const r = await patch({ groups: [] });
    assert.equal(r.status, 200);
    assert.deepEqual((r.json as PatchResponse).resolvedByOutput.wall?.groups, []);
  });

  it("refuses an id that names no group with a 400 that names it, and changes nothing", async () => {
    await patch({ groups: [green] });
    const r = await patch({ groups: [green, "g-00000000"] });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /g-00000000/);
    assert.deepEqual(stageController.getState().resolvedByOutput.wall?.groups, [green], "a refused request changed the groups");
  });

  it("refuses a value that is not a list of ids, with a 400 and a reason", async () => {
    for (const bad of ["g-00000000", { 0: green }, [5], null]) {
      const r = await patch({ groups: bad });
      assert.equal(r.status, 400, `accepted ${JSON.stringify(bad)}`);
      assert.match((r.json as { error: string }).error, /array of group ids/);
    }
  });

  it("is named in the answer to a body with nothing valid in it", async () => {
    const r = await patch({ nothing: true });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /body\.groups \(string\[\]\)/);
  });

  it("combines with the other output flags in one request", async () => {
    const r = await patch({ groups: [green], allowHls: false, locked: true });
    assert.equal(r.status, 200);
    const wall = (r.json as PatchResponse).outputs.find((o) => o.id === "wall");
    assert.deepEqual(
      { groups: wall?.groups, allowHls: wall?.allowHls, locked: wall?.locked },
      { groups: [green], allowHls: false, locked: true },
    );
  });
});
