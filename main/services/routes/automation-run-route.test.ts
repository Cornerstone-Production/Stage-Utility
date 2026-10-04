// POST /api/automation/rules/:id/run at the HTTP boundary, through the real route
// module and the real engine (route-harness, no stubbed engine).
//
// The engine's own cases are in automation-engine.test.ts; what is guarded here
// is what only the route decides: the status codes, that `confirmed` must be the
// literal boolean true, and who the caller is.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "automation-run-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationRoutes } = await import("./automation-routes.js");
const { callRoute } = await import("./route-harness.js");
const { automationEngine } = await import("../automation-engine.js");
const { automationLog } = await import("../automation-log.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

before(async () => {
  await automationEngine.init();
});

beforeEach(async () => {
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  await automationEngine.setSettings({ simulate: false, disarmed: false });
});

/** What the app's own page sends: an Origin naming this server. */
const browser = { origin: "http://stage.local:8788", host: "stage.local:8788" };

async function rule(over: Record<string, unknown> = {}): Promise<string> {
  const r = await automationEngine.addRule({
    name: "Log it",
    enabled: false,
    trigger: { id: "pco.service-started", params: {} },
    conditions: [],
    action: { id: "log.message", params: { message: "hello" } },
    cooldownSec: 0,
    oncePerService: false,
    ...over,
  });
  return r.id;
}

const post = (id: string, body?: unknown, headers: Record<string, string> = browser) =>
  callRoute(automationRoutes, `/api/automation/rules/${id}/run`, { method: "POST", headers, body });

describe("POST /api/automation/rules/:id/run", () => {
  test("200 with the outcome and detail, on a disabled rule", async () => {
    const id = await rule();
    const r = await post(id, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { outcome: "fired", detail: "hello" });
  });

  test("simulate is reported as simulated", async () => {
    await automationEngine.setSettings({ simulate: true });
    const r = await post(await rule(), {});
    assert.equal((r.json as { outcome: string }).outcome, "simulated");
  });

  test("404 for an unknown rule", async () => {
    assert.equal((await post("nope", {})).status, 404);
  });

  test("409 with the reason while disarmed", async () => {
    const id = await rule();
    await automationEngine.setSettings({ disarmed: true });
    const r = await post(id, {});
    assert.equal(r.status, 409);
    assert.match((r.json as { error: string }).error, /disarmed/i);
  });

  test("428 for a confirm rule without confirmed: true, and for a truthy non-boolean", async () => {
    const id = await rule({ confirmRequired: true });
    assert.equal((await post(id, {})).status, 428);
    assert.equal((await post(id, { confirmed: "true" })).status, 428);
    assert.equal((await post(id, { confirmed: true })).status, 200);
  });

  test("a same-origin browser is logged as console", async () => {
    await post(await rule(), {});
    assert.equal(automationLog.list()[0].caller, "console");
  });

  test("no Origin and no token is 401, and runs nothing", async () => {
    const r = await post(await rule(), {}, {});
    assert.equal(r.status, 401);
    assert.equal(automationLog.list().length, 0);
  });

  test("a built-in cue can be run, though it is not in the stored rules", async () => {
    const builtin = automationEngine.rulesWithBuiltins().find((r) => r.action.id === "display.refresh");
    assert.ok(builtin, "display.refresh is a built-in that needs no integration");
    assert.ok(!automationEngine.listRules().some((r) => r.id === builtin.id));
    await automationEngine.setSettings({ simulate: true });
    const r = await post(builtin.id, {});
    assert.equal(r.status, 200);
    assert.equal((r.json as { outcome: string }).outcome, "simulated");
  });
});
