// Setting and releasing a take-over.
//
// An override is what an operator reaches for under pressure — something has to
// go on the foyer screens now — so the failure that matters is one that looks
// like it worked. Every rejection here produces a stated reason rather than a
// stored override that resolves to nothing, which on a wall is indistinguishable
// from a bug.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-signage-override-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { callRoute } = await import("./route-harness.js");
const { signageRoutes } = await import("./signage-routes.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const post = (groupId: string, body: unknown) =>
  callRoute(signageRoutes, `/api/signage/groups/${groupId}/override`, { method: "POST", body });

before(async () => {
  await callRoute(signageRoutes, "/api/signage/groups", {
    method: "POST",
    body: { group: { id: "g1", name: "Foyer", outputIds: [], createdAt: "" } },
  });
  await callRoute(signageRoutes, "/api/signage/playlists", {
    method: "POST",
    body: {
      playlist: {
        id: "p1", name: "Building fund", items: [], defaultDurationMs: 8000,
        fit: "contain", transition: { kind: "cut", ms: 0 }, createdAt: "",
      },
    },
  });
});

describe("setting an override", () => {
  test("refuses one that names neither a playlist nor blank", () => {
    // It would resolve as "nothing", which on a dark wall is indistinguishable
    // from a bug — and the operator would have pressed a button that appeared
    // to work.
    return post("g1", {}).then((r) => {
      assert.equal(r.status, 400);
      assert.match(String((r.json as { error: string }).error), /playlist or blank/i);
    });
  });

  test("refuses one naming BOTH", async () => {
    const r = await post("g1", { playlistId: "p1", blank: true });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /playlist or blank/i);
  });

  test("refuses a playlist that does not exist", async () => {
    const r = await post("g1", { playlistId: "nope" });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /playlist/i);
  });

  test("refuses a group that does not exist", async () => {
    // Otherwise a stale page can store an override nothing will ever read, and
    // the banner would name a group that is not there.
    const r = await post("no-such-group", { playlistId: "p1" });
    assert.equal(r.status, 404);
  });

  test("accepts a playlist, and stamps when it started", async () => {
    const r = await post("g1", { playlistId: "p1" });
    assert.equal(r.status, 200);
    const o = (r.json as { override: { playlistId: string; startedAt: number } }).override;
    assert.equal(o.playlistId, "p1");
    assert.ok(o.startedAt > 0, "an override with no start time cannot be ordered against another");
  });

  test("accepts an explicit blank", async () => {
    const r = await post("g1", { blank: true });
    assert.equal(r.status, 200);
    assert.equal((r.json as { override: { blank: boolean } }).override.blank, true);
  });

  test("a second take-over REPLACES the first rather than stacking", async () => {
    await post("g1", { playlistId: "p1" });
    const list = await callRoute(signageRoutes, "/api/signage/overrides");
    const mine = (list.json as { overrides: { groupId: string }[] }).overrides.filter(
      (o) => o.groupId === "g1",
    );
    assert.equal(mine.length, 1, "two overrides were stored for one group");
  });
});

describe("releasing an override", () => {
  test("removes it", async () => {
    const r = await callRoute(signageRoutes, "/api/signage/groups/g1/override", { method: "DELETE" });
    assert.equal(r.status, 200);
    const list = await callRoute(signageRoutes, "/api/signage/overrides");
    assert.equal((list.json as { overrides: unknown[] }).overrides.length, 0);
  });

  test("releasing one that is not there is not an error", async () => {
    // The operator's intent is "no override on this group", and that is already
    // true. Failing would only be noise on a screen someone is trying to fix.
    const r = await callRoute(signageRoutes, "/api/signage/groups/g1/override", { method: "DELETE" });
    assert.equal(r.status, 200);
  });
});
