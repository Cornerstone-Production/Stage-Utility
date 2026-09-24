// A rule already enabled with param issues — one that predates this feature,
// or one a config restore just landed — must not be silently turned off.
// docs/automation.md: "It shows Needs setup and is enforced when next saved
// or enabled" — not on load, and not by a maintenance pass that never touches
// `enabled` at all.
//
// WRITTEN BEFORE THE IMPORT, exactly as automation-init-validates-cues.test.ts
// does: automationStore's DataStore caches in memory after its first read, so
// writing the file after importing the engine would test a warm cache echoing
// back whatever an earlier read (or this file's own writes) already cached —
// not what a real restore produces. A real restore's own process exits and a
// fresh one starts, so its first read really is cold; this is what makes a
// single test file's first read cold too.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "automation-restore-keeps-issues-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

/** Missing "meter" (required) and "targetId" (required) — two real, unrelated
 *  registry fields, not a stub shape. */
const LEGACY_RULE = {
  id: "legacy-1",
  name: "Legacy alarm",
  enabled: true,
  trigger: { id: "spl.crossed-above", params: { threshold: 95 } },
  conditions: [],
  action: { id: "rosstalk.command", params: { commandId: "cut" } },
  cooldownSec: 0,
  oncePerService: false,
};

await fs.writeFile(path.join(TMP, "automation-rules.json"), JSON.stringify([LEGACY_RULE]), "utf8");

const { automationEngine } = await import("./automation-engine.js");
const { automationRoutes } = await import("./routes/automation-routes.js");
const { callRoute } = await import("./routes/route-harness.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

before(async () => {
  await automationEngine.init();
});

describe("a legacy rule already enabled with issues", () => {
  test("init() does not disable it", () => {
    const rule = automationEngine.listRules().find((r) => r.id === "legacy-1");
    assert.equal(rule?.enabled, true, "loading it from disk must not flip its enabled flag");
  });

  test("GET /api/automation/rules reports its issues without writing anything", async () => {
    const res = await callRoute(automationRoutes, "/api/automation/rules");
    const row = (res.json as { rules: { id: string; issues: { key: string }[] }[] }).rules.find(
      (r) => r.id === "legacy-1",
    );
    assert.deepEqual(row?.issues.map((i) => i.key).sort(), ["meter", "targetId"]);
    assert.equal(automationEngine.listRules().find((r) => r.id === "legacy-1")?.enabled, true, "GET must not write");
  });

  test("a maintenance patch through automationEngine.updateRule directly (reconcile, learning) does not disable it", async () => {
    // The shape a reconcile pass or the state-learning probe actually sends:
    // a patch to ONE field, never touching `enabled` — see companion-reconcile.ts
    // and companion-state-probe.ts, both of which call this method directly,
    // never through the HTTP route above.
    await automationEngine.updateRule("legacy-1", { name: "Legacy alarm (renamed)" });
    const rule = automationEngine.listRules().find((r) => r.id === "legacy-1");
    assert.equal(rule?.enabled, true, "a maintenance patch bypassing the route must not disable a legacy rule");
    assert.equal(rule?.name, "Legacy alarm (renamed)");
  });

  test("the route DOES enforce it on the rule's own next save", async () => {
    // The one place enforcement happens: an operator's own update through the
    // HTTP route, same as the rest of this file's tests exercise directly.
    const res = await callRoute(automationRoutes, "/api/automation/rules/legacy-1", {
      method: "PATCH",
      body: { name: "Legacy alarm (edited)" },
    });
    assert.equal(res.status, 200);
    const body = res.json as { rule: { enabled: boolean } };
    assert.equal(body.rule.enabled, false, "the next save through the route must enforce it");
  });
});
