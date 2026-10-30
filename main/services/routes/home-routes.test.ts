// The snooze routes, driven through the real handler and a real data directory.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-home-route-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { homeRoutes } = await import("./home-routes.js");
const { callRoute } = await import("./route-harness.js");
const { homeSnoozes } = await import("../home-snoozes.js");
const { ROUTE_MODULES } = await import("../remote-server.js");
type HomeSnoozesState = import("../../types/home-snoozes.js").HomeSnoozesState;

await homeSnoozes.start();

describe("/api/home/snoozes", () => {
  it("is dispatched by the server", () => {
    assert.ok(ROUTE_MODULES.includes(homeRoutes));
  });

  it("POST snoozes, GET lists, DELETE removes", async () => {
    const post = await callRoute(homeRoutes, "/api/home/snoozes", { method: "POST", body: { key: "screen:lobby", severity: "warn" } });
    assert.equal(post.status, 201);
    const list = (await callRoute(homeRoutes, "/api/home/snoozes")).json as HomeSnoozesState;
    assert.deepEqual(list.snoozes.map((s) => [s.key, s.severity]), [["screen:lobby", "warn"]]);
    assert.equal(typeof list.rev, "number");
    const del = await callRoute(homeRoutes, "/api/home/snoozes/screen%3Alobby", { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.deepEqual(((await callRoute(homeRoutes, "/api/home/snoozes")).json as HomeSnoozesState).snoozes, []);
  });

  it("a bad key or severity is a 400 that says which, and DELETE of a stranger is a 404", async () => {
    const badKey = await callRoute(homeRoutes, "/api/home/snoozes", { method: "POST", body: { key: "no subject", severity: "warn" } });
    assert.equal(badKey.status, 400);
    assert.match((badKey.json as { error: string }).error, /key/);
    const badSev = await callRoute(homeRoutes, "/api/home/snoozes", { method: "POST", body: { key: "a:b", severity: "meh" } });
    assert.equal(badSev.status, 400);
    assert.match((badSev.json as { error: string }).error, /severity/);
    assert.equal((await callRoute(homeRoutes, "/api/home/snoozes/a%3Ab", { method: "DELETE" })).status, 404);
    assert.equal((await callRoute(homeRoutes, "/api/home/snoozes/%E0%A4%A", { method: "DELETE" })).status, 400);
  });
});
