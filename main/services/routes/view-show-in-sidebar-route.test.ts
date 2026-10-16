// PATCH /api/views/:id's `showInSidebar` field, driven through the real handler.
//
// The controller's own behaviour (persistence, independence from the surface) is
// main/services/view-show-in-sidebar.test.ts. This is the HTTP boundary: the body
// the route accepts, the 400 it gives a malformed one, and that a bad value next
// to a good one is refused rather than quietly dropped.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { describe, it } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-showinsidebar-route-");

const flag = () => stageController.getState().views.find((v) => v.id === "v1")?.showInSidebar;

/** views.json as written, read back rather than trusted from memory. */
async function flagOnDisk(): Promise<boolean | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(`${process.env.STAGE_UTILITY_DATA}/views.json`, "utf8");
  } catch (err) {
    // No file is the bug this reads for, not an error to report as one.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as View[] | { views?: View[] };
  const views = Array.isArray(parsed) ? parsed : (parsed.views ?? []);
  return views.find((v) => v.id === "v1")?.showInSidebar;
}

describe("PATCH /api/views/:id — showInSidebar", () => {
  it("accepts false, answers with the changed view, and writes it to disk", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { showInSidebar: false } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const body = r.json as { views: View[] };
    assert.equal(body.views.find((v) => v.id === "v1")?.showInSidebar, false, "the response does not carry it");
    assert.equal(flag(), false);
    assert.equal(await flagOnDisk(), false, "the PATCH never reached views.json");
  });

  it("accepts true, listing it again", async () => {
    await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { showInSidebar: false } });
    const r = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { showInSidebar: true } });
    assert.equal(r.status, 200);
    assert.equal(flag(), true);
    assert.equal(await flagOnDisk(), true);
  });

  it("refuses a non-boolean with a 400 that says why, and changes nothing", async () => {
    for (const bad of ["no", 0, null, {}]) {
      const r = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: { showInSidebar: bad } });
      assert.equal(r.status, 400, `accepted ${JSON.stringify(bad)}`);
      assert.match((r.json as { error: string }).error, /showInSidebar/);
    }
    assert.equal(flag(), undefined, "a refused body must change nothing");
  });

  it("refuses a bad value even when the body also carries a good field", async () => {
    // Saved quietly, the rename would land and the console would stay listed with
    // no word said about it.
    const r = await callRoute(viewRoutes, "/api/views/v1", {
      method: "PATCH",
      body: { name: "Renamed", showInSidebar: "no" },
    });
    assert.equal(r.status, 400);
    assert.equal(stageController.getState().views.find((v) => v.id === "v1")?.name, "Mic board", "the good half was applied");
  });

  it("is listed in the 'nothing valid' message, so a caller can find the field", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v1", { method: "PATCH", body: {} });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /body\.showInSidebar \(boolean\)/);
  });
});
