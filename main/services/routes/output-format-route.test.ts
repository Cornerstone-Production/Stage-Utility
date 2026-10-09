// PATCH /api/outputs/:id's `rotation` and `videoMode`, driven through the real
// handler and the real controller, and read back from the file on disk.
//
// Both are for the Mac output helper, which reads them from the outputs in the
// stage state. What matters is that a value the route accepts is the value that
// is stored and survives a restart, and that a value it refuses leaves the
// screen exactly as it was: a 400 that had already half-applied would send a
// monitor to the wrong rotation while the operator read an error.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-output-format-");

type PatchResponse = { outputs: Output[] };
const patch = (body: Record<string, unknown>) =>
  callRoute(viewRoutes, "/api/outputs/wall", { method: "PATCH", body });
const wall = () => stageController.getState().outputs.find((o) => o.id === "wall");

/** The outputs as they are on disk, read back rather than trusted. */
async function storedWall(): Promise<Output | undefined> {
  const raw = await fs.readFile(path.join(process.env.STAGE_UTILITY_DATA!, "settings.json"), "utf8");
  return (JSON.parse(raw) as { outputs?: Output[] }).outputs?.find((o) => o.id === "wall");
}

describe("PATCH /api/outputs/:id — rotation", () => {
  it("is absent until one is set", () => {
    assert.equal(wall()?.rotation, undefined);
  });

  for (const rotation of [0, 90, 180, 270]) {
    it(`accepts ${rotation}, carries it in the response and writes it to disk`, async () => {
      // Start from somewhere else, so 0 is a change and not a no-op.
      await patch({ rotation: rotation === 90 ? 180 : 90 });
      const r = await patch({ rotation });
      assert.equal(r.status, 200);
      assert.equal((r.json as PatchResponse).outputs.find((o) => o.id === "wall")?.rotation, rotation);
      assert.equal((await storedWall())?.rotation, rotation, "the rotation was not persisted");
    });
  }

  for (const bad of [45, 360, -90, 90.5, "90", null, true]) {
    it(`refuses ${JSON.stringify(bad)} with a 400 and changes nothing`, async () => {
      await patch({ rotation: 180 });
      const r = await patch({ rotation: bad });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /rotation must be one of 0, 90, 180, 270/);
      assert.equal(wall()?.rotation, 180, "a refused request changed the rotation");
      assert.equal((await storedWall())?.rotation, 180);
    });
  }

  it("setting what it already is writes nothing", async () => {
    await patch({ rotation: 90 });
    const before = await fs.stat(path.join(process.env.STAGE_UTILITY_DATA!, "settings.json"));
    await new Promise((r) => setTimeout(r, 20));
    const r = await patch({ rotation: 90 });
    assert.equal(r.status, 200);
    const after = await fs.stat(path.join(process.env.STAGE_UTILITY_DATA!, "settings.json"));
    assert.equal(after.mtimeMs, before.mtimeMs, "an unchanged rotation rewrote the settings file");
  });

  it("0 on a screen that never had one is not stored", async () => {
    const r = await patch({ rotation: 0 });
    assert.equal(r.status, 200);
    assert.equal(wall()?.rotation, undefined, "absent already means 0, so nothing is written");
  });
});

describe("PATCH /api/outputs/:id — videoMode", () => {
  it("is absent until one is set", () => {
    assert.equal(wall()?.videoMode, undefined);
  });

  it("accepts a known mode, carries it in the response and writes it to disk", async () => {
    const r = await patch({ videoMode: "1080i59.94" });
    assert.equal(r.status, 200);
    assert.equal((r.json as PatchResponse).outputs.find((o) => o.id === "wall")?.videoMode, "1080i59.94");
    assert.equal((await storedWall())?.videoMode, "1080i59.94", "the mode was not persisted");
  });

  it("the default, on a screen that never had one, is not stored", async () => {
    const r = await patch({ videoMode: "1080p59.94" });
    assert.equal(r.status, 200);
    assert.equal(wall()?.videoMode, undefined);
  });

  for (const bad of ["1080p61", "1080P59.94", "", 59.94, null, ["1080p60"]]) {
    it(`refuses ${JSON.stringify(bad)} with a 400 and changes nothing`, async () => {
      await patch({ videoMode: "720p50" });
      const r = await patch({ videoMode: bad });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /videoMode must be one of 1080i50, /);
      assert.equal(wall()?.videoMode, "720p50", "a refused request changed the mode");
      assert.equal((await storedWall())?.videoMode, "720p50");
    });
  }

  it("combines with rotation in one request", async () => {
    const r = await patch({ videoMode: "1080p50", rotation: 270 });
    assert.equal(r.status, 200);
    assert.deepEqual(
      { videoMode: wall()?.videoMode, rotation: wall()?.rotation },
      { videoMode: "1080p50", rotation: 270 },
    );
  });
});
