// A stageplots.json that will not parse is moved aside and read as no plots at all. The plot
// editor's drafts are a separate file, and reading them then must not take that for "every plot
// is gone": GET /api/stageplots/drafts leaves out what it cannot match and deletes nothing.
//
// Its own file, because the damage has to be on disk before the store's first read in this
// process: the route module's real stores, a real data directory, nothing stubbed.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-drafts-damaged-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const DRAFT = {
  plotId: "p-1",
  baseVersion: 2,
  items: [{ id: "i-1", type: "box", x: 10, y: 10, w: 100, h: 50, rotation: 0, label: "Riser", color: null, notes: "", inputs: [] }],
  savedAt: "2026-11-14T14:32:00.000Z",
};
await fs.writeFile(path.join(TMP, "stageplots.json"), '{"venues":[{"id":"v-1","name":"Main', "utf8");
await fs.writeFile(path.join(TMP, "stageplot-drafts.json"), JSON.stringify({ drafts: [DRAFT] }), "utf8");

const { callRoute } = await import("./route-harness.js");
const { stageplotsRoutes } = await import("./stageplots-routes.js");
const { stageplotsStore } = await import("../stageplots-store.js");

after(() => fs.rm(TMP, { recursive: true, force: true }));

test("a damaged stageplots.json leaves every draft where it is: the read leaves them out and deletes none", async () => {
  const quiet = [console.error, console.warn] as const;
  const said: string[] = [];
  console.error = () => undefined;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  let r: Awaited<ReturnType<typeof callRoute>>;
  try {
    r = await callRoute(stageplotsRoutes, "/api/stageplots/drafts", { method: "GET" });
  } finally {
    [console.error, console.warn] = quiet;
  }
  assert.ok(stageplotsStore.loadedFromCorrupt, "the plots file was read; the test is not testing a damaged one");
  assert.equal(r.status, 200, r.body);
  assert.deepEqual((r.json as { drafts: unknown[] }).drafts, [], "a draft of a plot the damaged file does not show was answered");
  const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "stageplot-drafts.json"), "utf8")) as { drafts: unknown[] };
  assert.deepEqual(onDisk.drafts, [DRAFT], "the read deleted the drafts of every plot it could not see");
  assert.deepEqual(
    said.filter((w) => w.startsWith("[stageplots]")),
    ["[stageplots] 1 unsaved drafts left out: their plots are not in stageplots.json (p-1); they stay in stageplot-drafts.json"],
  );
});
