// A stored rule with no `conditions` (a restore may land one: the restore check
// and docs/automation.md allow omitting it) reads as having none, so the list,
// a patch and the engine never meet undefined. Seeded before the import for the
// cold first read, as automation-restore-keeps-issues.test.ts does.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "automation-rule-without-conditions-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

await fs.writeFile(
  path.join(TMP, "automation-rules.json"),
  JSON.stringify([
    {
      id: "no-conds",
      name: "No conditions",
      enabled: false,
      trigger: { id: "spl.crossed-above", params: { meter: "carbonite::1", threshold: 95 } },
      action: { id: "rosstalk.command", params: { targetId: "t1", commandId: "cut" } },
      cooldownSec: 0,
      oncePerService: false,
    },
  ]),
  "utf8",
);

const { automationEngine } = await import("./automation-engine.js");
const { automationRoutes } = await import("./routes/automation-routes.js");
const { callRoute } = await import("./routes/route-harness.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});
before(async () => {
  await automationEngine.init();
});

describe("a stored rule with no conditions", () => {
  test("listRules gives conditions []", () => {
    assert.deepEqual(automationEngine.listRules()[0].conditions, []);
  });

  test("GET /api/automation/rules answers 200 with conditions []", async () => {
    const res = await callRoute(automationRoutes, "/api/automation/rules");
    assert.equal(res.status, 200);
    const rules = (res.json as { rules: { conditions: unknown[] }[] }).rules;
    assert.deepEqual(rules[0].conditions, []);
  });

  test("PATCH answers 200", async () => {
    const res = await callRoute(automationRoutes, "/api/automation/rules/no-conds", {
      method: "PATCH",
      body: { cooldownSec: 3 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(automationEngine.listRules()[0].conditions, []);
  });
});
