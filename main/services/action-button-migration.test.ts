// The Run an action Button pass, run through its real callers and against the real engine.
//
// view-import.test.ts asserts the rules STORE after an import, which stayed green while the
// running engine never heard of the new command: the press 404'd and the engine's next
// save wrote the store back without it. These tests ask the engine.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import type { View } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "action-button-migration-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { viewsStore } = await import("./views-store.js");
const { automationStore } = await import("./automation-store.js");
const { automationEngine } = await import("./automation-engine.js");
const { applyViewBundle } = await import("./view-import.js");
const { planActionButtonMigration } = await import("./action-button-migration.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const actionButton = (config: Record<string, unknown>) => ({ id: "o-1", x: 0.1, y: 0.1, w: 0.2, h: 0.1, z: 1, config: { type: "action-button", ...config } });
const view = (objects: unknown[]): View =>
  ({ id: "view-1", name: "Booth", kind: "custom", createdAt: 0, layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects } }) as unknown as View;
const bundle = (objects: unknown[]) => ({
  kind: "stage-utility-view", version: 1, appVersion: "1.0.0", createdAt: "2026-08-17T00:00:00.000Z", source: { server: "Elsewhere" },
  views: [view(objects)],
  sideData: { slots: {}, notes: {}, serviceCueLayouts: [] }, targets: { osc: [], rosstalk: [] }, images: {},
});

describe("an imported Run an action Button, with the engine running", () => {
  test("its command is in the engine, a press resolves, and the next rule edit keeps it", async () => {
    await automationStore.saveRules([]);
    await viewsStore.save([] as never);
    await automationEngine.init();
    await applyViewBundle(bundle([actionButton({ actionId: "obs.record", params: { mode: "toggle" }, label: "Record" })]));

    assert.ok(
      automationEngine.listRules().some((r) => r.trigger.params.name === "btn_record"),
      "the imported Button's rule is on disk but not in the running engine",
    );
    const pressed = await automationEngine.callByName("btn_record", { caller: "test" });
    assert.notEqual(pressed.status, 404, JSON.stringify(pressed.body));

    await automationEngine.addRule({
      name: "Other", enabled: false, trigger: { id: "call.by-name", params: { name: "other_cue" } },
      conditions: [], action: { id: "log.message", params: { message: "x" } }, cooldownSec: 0, oncePerService: false,
    } as never);
    const names = (await automationStore.loadRules()).map((r) => r.trigger.params.name);
    assert.ok(names.includes("btn_record"), `an unrelated edit erased the command: ${JSON.stringify(names)}`);
  });
});

describe("a stored Run an action Button that cannot be converted", () => {
  const label = () => undefined;
  for (const [what, config] of [
    ["no action id", { label: "Go" }],
    ["a non-string action id", { actionId: 7, label: "Go" }],
    ["an empty action id (1.27's default)", { actionId: "", params: {}, label: "Action" }],
  ] as const) {
    test(`${what} is left alone and counted, never thrown on, and makes no nameless rule`, () => {
      const plan = planActionButtonMigration([view([actionButton(config)])], [], label);
      assert.equal(plan.count, 0);
      assert.equal(plan.unconfigured, 1);
      assert.deepEqual(plan.rules, []);
      assert.equal((plan.views[0]!.layout!.objects[0]!.config as { type: string }).type, "action-button");
    });
  }

  test("the run says so on the log", async (t) => {
    const { runActionButtonMigration } = await import("./action-button-migration.js");
    const lines = captureConsole(t, "warn");
    const run = await runActionButtonMigration([view([actionButton({ actionId: "", params: {}, label: "Action" })])]);
    assert.equal(run.failure, null);
    assert.ok(lines.some((l) => l.startsWith("[automation]") && l.includes("no action chosen")), JSON.stringify(lines));
  });
});
