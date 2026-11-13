// GET /api/stageplots/patch: the patch a linked connection point resolves against. Its own
// file, because it starts on a damaged patch.json, and a store reads its file once.
//
// The point of the route: a patch that cannot be read is a 503 the editor and /stageplots
// show as "unlinked · patch sheet unavailable", never the seed sheets, against which every
// link would read "device removed".

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-patch-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
await fs.writeFile(path.join(TMP, "patch.json"), "{ not json");
const quiet = console.error;
console.error = () => undefined;

const { callRoute } = await import("./route-harness.js");
const { stageplotsRoutes } = await import("./stageplots-routes.js");
const { patchStore } = await import("../patch-store.js");

after(async () => {
  console.error = quiet;
  await fs.rm(TMP, { recursive: true, force: true });
});

test("a damaged patch.json is a 503, not the seed sheets, until a patch is saved over it", async () => {
  const before = await callRoute(stageplotsRoutes, "/api/stageplots/patch", { method: "GET" }).catch((err: { status?: number }) => ({ status: err.status }));
  assert.equal(before.status, 503);
  // /api/patch keeps answering the seeds, as it always has.
  assert.equal((await patchStore.load()).sheets.length, 4);

  const saved = await patchStore.save({ sheets: [{ id: "main", name: "Main patch", kind: "analog", devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} } }], updatedAt: "" });
  const r = await callRoute(stageplotsRoutes, "/api/stageplots/patch", { method: "GET" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, saved);
});
