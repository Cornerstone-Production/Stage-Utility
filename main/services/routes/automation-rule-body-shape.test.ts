// A rule body whose steps are missing or the wrong shape is the caller's
// mistake: 400 with what is wrong, never a 500 from a property read on
// undefined. Through the REAL route module and engine, like
// automation-rules-validation.test.ts.
//
// `conditions` is optional on a create (docs/automation.md: "zero or more
// conditions"), so a missing one is saved as []. Present, it must be an array of
// { id, params } steps. The same holds for `trigger` and `action`, and a PATCH
// judges whichever of them it carries.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "automation-rule-body-shape-"));
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
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
});

function rule(over: Record<string, unknown> = {}) {
  return {
    name: "SPL alarm cue",
    enabled: false,
    trigger: { id: "spl.crossed-above", params: { meter: "carbonite::1", threshold: 95 } },
    conditions: [],
    action: { id: "rosstalk.command", params: { targetId: "t1", commandId: "cut" } },
    cooldownSec: 0,
    oncePerService: false,
    ...over,
  };
}

const post = (body: unknown) => callRoute(automationRoutes, "/api/automation/rules", { method: "POST", body });
const patch = (id: string, body: unknown) =>
  callRoute(automationRoutes, `/api/automation/rules/${id}`, { method: "PATCH", body });
const errorOf = (res: { json: unknown }) => (res.json as { error: string }).error;

describe("POST /api/automation/rules body shape", () => {
  test("no conditions at all saves with conditions []", async () => {
    const { conditions: _omitted, ...body } = rule();
    const res = await post(body);
    assert.equal(res.status, 201);
    assert.deepEqual((res.json as { conditions: unknown[] }).conditions, []);
    assert.deepEqual(automationEngine.listRules()[0].conditions, []);
  });

  for (const [label, conditions] of [
    ["a string", "x"],
    ["an object", {}],
    ["null", null],
    ["an array holding a non-step", ["x"]],
    ["a step with no id", [{ params: {} }]],
    ["a step whose params is not an object", [{ id: "service.live", params: "x" }]],
  ] as const) {
    test(`conditions as ${label} is 400 and creates nothing`, async () => {
      const res = await post(rule({ conditions }));
      assert.equal(res.status, 400);
      assert.match(errorOf(res), /body\.conditions/);
      assert.equal(automationEngine.listRules().length, 0);
    });
  }

  for (const key of ["trigger", "action"] as const) {
    for (const [label, value] of [
      ["a string", "x"],
      ["an array", []],
      ["a step with a non-string id", { id: 5, params: {} }],
      ["a step whose params is an array", { id: "x", params: [] }],
    ] as const) {
      test(`${key} as ${label} is 400 and creates nothing`, async () => {
        const res = await post(rule({ [key]: value }));
        assert.equal(res.status, 400);
        assert.match(errorOf(res), new RegExp(`body\\.${key}`));
        assert.equal(automationEngine.listRules().length, 0);
      });
    }
  }

  test("a step with no params is saved with params {}", async () => {
    const res = await post(rule({ conditions: [{ id: "service.live" }] }));
    assert.equal(res.status, 201);
    assert.deepEqual((res.json as { conditions: unknown[] }).conditions, [{ id: "service.live", params: {} }]);
  });
});

describe("PATCH /api/automation/rules/:id body shape", () => {
  async function existing(): Promise<string> {
    const res = await post(rule());
    return (res.json as { id: string }).id;
  }

  test("conditions that are not an array is 400 and leaves the rule alone", async () => {
    const id = await existing();
    const res = await patch(id, { conditions: "x" });
    assert.equal(res.status, 400);
    assert.match(errorOf(res), /body\.conditions must be an array/);
    assert.deepEqual(automationEngine.listRules()[0].conditions, []);
  });

  for (const key of ["trigger", "action"] as const) {
    test(`${key} that is not a step is 400 and leaves the rule alone`, async () => {
      const id = await existing();
      const before = automationEngine.listRules()[0][key];
      const res = await patch(id, { [key]: "x" });
      assert.equal(res.status, 400);
      assert.match(errorOf(res), new RegExp(`body\\.${key}`));
      assert.deepEqual(automationEngine.listRules()[0][key], before);
    });
  }

  test("a patch that carries no steps is unaffected", async () => {
    const id = await existing();
    const res = await patch(id, { cooldownSec: 5 });
    assert.equal(res.status, 200);
  });
});

describe("a body that is not a JSON object", () => {
  for (const [label, body] of [["a number", 5], ["null", null], ["an array", []], ["a string", "x"]] as const) {
    test(`POST with ${label} is 400 and creates nothing`, async () => {
      const res = await post(body);
      assert.equal(res.status, 400);
      assert.equal(errorOf(res), "body must be a JSON object");
      assert.equal(automationEngine.listRules().length, 0);
    });
    test(`PATCH with ${label} is 400 and leaves the rule alone`, async () => {
      const made = await post(rule());
      const res = await patch((made.json as { id: string }).id, body);
      assert.equal(res.status, 400);
      assert.equal(errorOf(res), "body must be a JSON object");
    });
  }
});
