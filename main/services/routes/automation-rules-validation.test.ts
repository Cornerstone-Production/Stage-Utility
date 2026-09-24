// Save-time param validation, at the HTTP boundary — the layer a stale browser
// tab cannot get around, per docs/automation.md.
//
// Every case here goes through the REAL route module and the REAL engine
// (route-harness, no stubbed automationEngine), against a throwaway data dir —
// the same pattern automation-init-validates-cues.test.ts uses for "a rule this
// app did not write arrived anyway".
//
// Three things are guarded that have no other check anywhere:
//  - a create or update with issues is saved anyway, turned OFF, not refused.
//  - an explicit ask to ENABLE a rule that still has issues IS refused (409),
//    and leaves the stored rule untouched.
//  - a rule already enabled with issues (predates this feature, or was loaded
//    from a restore) is NOT touched by init(), by a maintenance patch that goes
//    straight through automationEngine.updateRule, or by GET — only an
//    operator's own create/update through this route enforces it.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "automation-rules-validation-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationRoutes } = await import("./automation-routes.js");
const { callRoute } = await import("./route-harness.js");
const { automationEngine } = await import("../automation-engine.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

before(async () => {
  await automationEngine.init();
});

beforeEach(async () => {
  // Each test starts from an empty rules file — removing through the real API
  // rather than poking the private array, so a leftover from one test cannot
  // make another pass by clashing on a cue name.
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
});

/** A rule with an SPL trigger missing its required "meter" string and a
 *  RossTalk action missing its required "targetId" enum — two issues, on two
 *  different steps, from real registry entries (not a stub). */
function badRule(over: Record<string, unknown> = {}) {
  return {
    name: "SPL alarm cue",
    enabled: false,
    trigger: { id: "spl.crossed-above", params: { threshold: 95 } }, // meter missing
    conditions: [],
    action: { id: "rosstalk.command", params: { commandId: "cut" } }, // targetId missing
    cooldownSec: 0,
    oncePerService: false,
    ...over,
  };
}

/** The same shape, fully filled in — zero issues. */
function goodRule(over: Record<string, unknown> = {}) {
  return {
    name: "SPL alarm cue",
    enabled: true,
    trigger: { id: "spl.crossed-above", params: { meter: "carbonite::1", threshold: 95 } },
    conditions: [],
    action: { id: "rosstalk.command", params: { targetId: "t1", commandId: "cut" } },
    cooldownSec: 0,
    oncePerService: false,
    ...over,
  };
}

describe("POST /api/automation/rules", () => {
  test("issues never block a create — the rule saves, reported turned off", async () => {
    const res = await callRoute(automationRoutes, "/api/automation/rules", { method: "POST", body: badRule() });
    assert.equal(res.status, 201);
    // The SAME shape GET's list items carry: the rule's own fields, flat, plus
    // `issues` — not a { rule, issues } wrapper. A script reading `.id` or
    // `.enabled` off this response must not break because this feature shipped.
    const body = res.json as { id: string; enabled: boolean; issues: { key: string }[] };
    assert.equal(body.enabled, false);
    assert.deepEqual(
      body.issues.map((i) => i.key).sort(),
      ["meter", "targetId"],
    );
    assert.equal(automationEngine.listRules().find((r) => r.id === body.id)?.enabled, false);
  });

  test("an explicit ask to create it ENABLED with issues is refused, and creates nothing", async () => {
    const before = automationEngine.listRules().length;
    const res = await callRoute(automationRoutes, "/api/automation/rules", {
      method: "POST",
      body: badRule({ enabled: true }),
    });
    assert.equal(res.status, 409);
    assert.equal((res.json as { code?: string }).code, "invalid-params");
    assert.equal(automationEngine.listRules().length, before, "a refused create must create nothing");
  });

  test("a clean rule saves exactly as asked, with an empty issues list", async () => {
    const res = await callRoute(automationRoutes, "/api/automation/rules", { method: "POST", body: goodRule() });
    assert.equal(res.status, 201);
    const body = res.json as { enabled: boolean; issues: unknown[] };
    assert.equal(body.enabled, true);
    assert.deepEqual(body.issues, []);
  });
});

describe("PATCH /api/automation/rules/:id", () => {
  async function createBad(): Promise<string> {
    const res = await callRoute(automationRoutes, "/api/automation/rules", { method: "POST", body: badRule() });
    return (res.json as { id: string }).id;
  }

  test("fixing three of four... a patch that still leaves issues saves turned off, even from enabled:true", async () => {
    const id = await createBad();
    // Fix the action's target, leave the trigger's meter blank, and ask for
    // enabled:true in the SAME patch a full "Save" would send — the route must
    // still turn it off rather than refuse the whole save.
    const res = await callRoute(automationRoutes, `/api/automation/rules/${id}`, {
      method: "PATCH",
      body: { action: { id: "rosstalk.command", params: { targetId: "t1", commandId: "cut" } }, enabled: true },
    });
    assert.equal(res.status, 200);
    const body = res.json as { enabled: boolean; issues: { key: string }[] };
    assert.equal(body.enabled, false, "one issue remains, so the save must not have turned it on");
    assert.deepEqual(body.issues.map((i) => i.key), ["meter"]);
    assert.equal(automationEngine.listRules().find((r) => r.id === id)?.enabled, false);
  });

  test("fixing every field and asking for enabled:true turns it back on", async () => {
    const id = await createBad();
    const res = await callRoute(automationRoutes, `/api/automation/rules/${id}`, {
      method: "PATCH",
      body: {
        trigger: { id: "spl.crossed-above", params: { meter: "carbonite::1", threshold: 95 } },
        action: { id: "rosstalk.command", params: { targetId: "t1", commandId: "cut" } },
        enabled: true,
      },
    });
    assert.equal(res.status, 200);
    const body = res.json as { enabled: boolean; issues: unknown[] };
    assert.equal(body.enabled, true);
    assert.deepEqual(body.issues, []);
  });

  test("an explicit ask to ENABLE a rule that still has issues is refused, and leaves it untouched", async () => {
    const id = await createBad();
    const res = await callRoute(automationRoutes, `/api/automation/rules/${id}`, {
      method: "PATCH",
      body: { enabled: true },
    });
    assert.equal(res.status, 409);
    // The 409 refusal body is unchanged: { error, code, issues }, never the
    // rule — nothing was written, so there is no rule shape to carry.
    const body = res.json as { error: string; code?: string };
    assert.equal(body.code, "invalid-params");
    assert.match(body.error, /Can't turn on "SPL alarm cue": 2 fields need attention\. Open it to fix them\./);
    assert.equal(automationEngine.listRules().find((r) => r.id === id)?.enabled, false, "the refused enable must not have written anything");
  });

  test("turning it off, with issues still present, is never refused", async () => {
    const id = await createBad();
    const res = await callRoute(automationRoutes, `/api/automation/rules/${id}`, {
      method: "PATCH",
      body: { enabled: false },
    });
    assert.equal(res.status, 200);
  });
});

describe("the [automation] log line an operator reads on /log", () => {
  async function captureLog(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await fn();
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
    return lines;
  }

  test("saving a rule with issues logs it, turned off, with the count", async () => {
    const lines = await captureLog(async () => {
      await callRoute(automationRoutes, "/api/automation/rules", { method: "POST", body: badRule() });
    });
    assert.ok(
      lines.some((l) => l.includes("[automation]") && l.includes("saved turned off") && l.includes("2 fields")),
      `expected a [automation] log line about the save, got ${JSON.stringify(lines)}`,
    );
  });

  test("refusing to enable a rule with issues logs it", async () => {
    const id = await (async () => {
      const res = await callRoute(automationRoutes, "/api/automation/rules", { method: "POST", body: badRule() });
      return (res.json as { id: string }).id;
    })();
    const lines = await captureLog(async () => {
      await callRoute(automationRoutes, `/api/automation/rules/${id}`, { method: "PATCH", body: { enabled: true } });
    });
    assert.ok(
      lines.some((l) => l.includes("[automation]") && l.includes("refused to enable")),
      `expected a [automation] log line about the refusal, got ${JSON.stringify(lines)}`,
    );
  });
});

describe("GET /api/automation/rules reports issues the list and the editor both read", () => {
  test("issues come back per rule, computed fresh — not stored on it", async () => {
    const id = await (async () => {
      const res = await callRoute(automationRoutes, "/api/automation/rules", { method: "POST", body: badRule() });
      return (res.json as { id: string }).id;
    })();
    const res = await callRoute(automationRoutes, "/api/automation/rules");
    const body = res.json as { rules: { id: string; issues: { key: string }[] }[] };
    const row = body.rules.find((r) => r.id === id);
    assert.deepEqual(row?.issues.map((i) => i.key).sort(), ["meter", "targetId"]);
  });
});

// A legacy rule already enabled with issues (predates this feature, or was
// just restored) is covered in automation-restore-keeps-issues.test.ts — that
// needs a genuinely cold DataStore cache (the file on disk written before the
// engine is ever imported), which this file's already-warm cache from the
// describes above cannot produce. See that file for why a restore's fresh
// process is what makes the real thing cold and this test's file-write is not.
