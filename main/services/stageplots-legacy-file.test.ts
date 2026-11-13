// A stageplots.json saved before overrides existed has no `overrides` key. The
// file is on disk before the store is first read, so this goes through the
// real load (DataStore's normalize), not a document built in memory, and then
// through GET and a write, which must not trip on the missing key.
//
// Every name below is invented. This is a public repository.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-legacy-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const OLD = {
  venues: [{ id: "v-1", name: "Main room", kind: "home", notes: "", plotIds: ["p-1", "p-2"], defaultPlotId: "p-1" }],
  backgrounds: [],
  plots: [
    { id: "p-1", venueId: "v-1", name: "Standard", backgroundId: null, bgFade: 0.4, items: [], version: 0 },
    { id: "p-2", venueId: "v-1", name: "Baptism", backgroundId: null, bgFade: 0.4, items: [], version: 0 },
  ],
};
await fs.writeFile(path.join(TMP, "stageplots.json"), JSON.stringify(OLD));

const { stageplotsStore } = await import("./stageplots-store.js");
const { callRoute } = await import("./routes/route-harness.js");
const { stageplotsRoutes } = await import("./routes/stageplots-routes.js");

after(() => fs.rm(TMP, { recursive: true, force: true }));

describe("a stageplots.json from before overrides", () => {
  test("reads as [] from the store and from GET", async () => {
    assert.deepEqual((await stageplotsStore.get()).overrides, []);
    const r = await callRoute(stageplotsRoutes, "/api/stageplots", { method: "GET" });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual((r.json as { overrides: unknown }).overrides, []);
  });

  test("takes an override, and a delete, without tripping on the missing key", async () => {
    let r = await callRoute(stageplotsRoutes, "/api/stageplots/overrides", { method: "PUT", body: { planId: "101", venueId: "v-1", plotId: "p-2", planDate: null } });
    assert.equal(r.status, 200, r.body);
    r = await callRoute(stageplotsRoutes, "/api/stageplots/venues/v-1", { method: "DELETE" });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(await stageplotsStore.get(), { venues: [], backgrounds: [], plots: [], overrides: [] });
  });
});
