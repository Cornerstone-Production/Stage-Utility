// The update lock, enforced by the server on every request that restarts it:
// POST /api/update/apply, /api/update/track and /api/update/restart. While a
// service is under way each answers 409 `locked` with the reasons, unless the
// body says `override: true`; an override goes ahead and is logged.
//
// Restart was guarded only by the dialog: anything else on the network, or a
// lock that began after the page read it, restarted the server mid-service.
// Apply's own 409 had no test at all: only GET /api/update/lock was asserted.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it, type TestContext } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-update-lock-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { systemRoutes } = await import("./system-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { updater } = await import("../updater.js");
const { captureConsole } = await import("../fixtures/capture-console.js");

const ctl = stageController as unknown as { lastLive: unknown; pcoAppId: string | null; pcoSecret: string | null };
const u = updater as unknown as Record<string, unknown>;
const real = { restart: u.restart, applyUpdate: u.applyUpdate, switchTrack: u.switchTrack };
let was: { lastLive: unknown; pcoAppId: string | null; pcoSecret: string | null };
/** What reached the updater, in order. */
let called: string[];

beforeEach(() => {
  was = { lastLive: ctl.lastLive, pcoAppId: ctl.pcoAppId, pcoSecret: ctl.pcoSecret };
  ctl.pcoAppId = null;
  ctl.pcoSecret = null;
  ctl.lastLive = null;
  called = [];
  u.restart = () => { called.push("restart"); return { phase: "idle" }; };
  u.applyUpdate = async () => { called.push("apply"); return { phase: "idle" }; };
  u.switchTrack = async () => { called.push("track"); return { phase: "idle" }; };
});
afterEach(() => {
  Object.assign(ctl, was);
  Object.assign(u, real);
});
after(() => fs.rm(TMP, { recursive: true, force: true }).catch(() => {}));

const post = (p: string, body: unknown) => callRoute(systemRoutes, p, { method: "POST", body });
const underWay = () => { ctl.lastLive = { mode: "item", currentItemId: "item-1" }; };

const ROUTES: [string, string, Record<string, unknown>][] = [
  ["/api/update/apply", "apply", {}],
  ["/api/update/restart", "restart", {}],
  ["/api/update/track", "track", { branch: "beta" }],
];

describe("a request that restarts the server, while a service is under way", () => {
  for (const [route, action, body] of ROUTES) {
    it(`${route} is refused 409 with the reasons, and reaches nothing`, async (t: TestContext) => {
      captureConsole(t, "log", "warn");
      underWay();
      const r = await post(route, body);
      assert.equal(r.status, 409, `${route} went ahead during a service`);
      assert.deepEqual(r.json, { error: "locked", locked: true, reasons: ["A PCO service is live"] });
      assert.deepEqual(called, []);
    });

    it(`${route} goes ahead with override: true, and says so on [updater]`, async (t: TestContext) => {
      const lines = captureConsole(t, "log", "warn");
      underWay();
      const r = await post(route, { ...body, override: true });
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(called, [action]);
      assert.equal(lines.filter((l) => /^\[updater\] .* went ahead while a service is under way \(A PCO service is live\): the update lock was overridden, as asked$/.test(l)).length, 1, lines.join("\n"));
    });
  }

  it("with nothing under way, each goes ahead without override and logs no override", async (t: TestContext) => {
    const lines = captureConsole(t, "log", "warn");
    for (const [route, , body] of ROUTES) assert.equal((await post(route, body)).status, 200, route);
    assert.deepEqual(called, ["apply", "restart", "track"]);
    assert.equal(lines.some((l) => /overridden/.test(l)), false);
  });
});
