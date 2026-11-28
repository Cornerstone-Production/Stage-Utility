// A patch save that stands while what follows it fails: POST /api/patch answers 500 with code
// `plot-links-not-updated` (the /api/messaging `groups-not-cleared` shape), the patch is stored
// and announced all the same, and the view import keeps its outcomes and says so.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { tempDataDir } from "../fixtures/temp-data-dir.js";

tempDataDir("patch-follower-");

const { callRoute } = await import("./route-harness.js");
const { serviceCueRoutes } = await import("./servicecue-routes.js");
const { patchStore, PatchLinksNotUpdated } = await import("../patch-store.js");
const { addBroadcastListener } = await import("../broadcaster.js");
type PatchFile = import("../../types/patch.js").PatchFile;

const quiet = { error: console.error };
const lines: string[] = [];
console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
after(async () => {
  console.error = quiet.error;
});

const file = (name: string): PatchFile => ({
  updatedAt: "",
  sheets: [{ id: "main", name, kind: "analog", devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} } }],
});

test("a follower that fails: the patch is saved and announced, POST /api/patch says 500 plot-links-not-updated, and [patch] logs it", async () => {
  patchStore.onSaved(async () => {
    throw new Error("stageplots.json is damaged");
  });
  const announced: string[] = [];
  addBroadcastListener((channel) => channel === "patch:updated" && announced.push(channel));

  const r = await callRoute(serviceCueRoutes, "/api/patch", { method: "POST", body: { file: file("Saved anyway") } });
  assert.equal(r.status, 500);
  assert.equal((r.json as { code?: string }).code, "plot-links-not-updated");
  assert.match((r.json as { error: string }).error, /patch was saved/i);
  assert.equal((await patchStore.load()).sheets[0]!.name, "Saved anyway", "the patch stands");
  assert.equal(announced.length, 1, "patch:updated still went out");
  assert.ok(lines.some((l) => l.startsWith("[patch]") && l.includes("stageplots.json is damaged")), lines.join(" / "));
  await assert.rejects(patchStore.save(file("Again")), PatchLinksNotUpdated);
});
