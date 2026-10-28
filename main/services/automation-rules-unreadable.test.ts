// An automation-rules.json that is there and cannot be read.
//
// The store serves its defaults, no rules, so the server keeps running. What must
// not happen is that "no rules" reaches anything outside the process: Home
// Assistant removes the entity of every cue the manifest stops listing, so an
// empty manifest from a failed read deleted them all, and an edit went live in
// memory, pressing Companion buttons, before its save was refused.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-rules-unreadable-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");
// A directory where the file should be fails the read for root as well.
await fs.mkdir(path.join(TMP, "automation-rules.json"));

const { automationEngine } = await import("./automation-engine.js");
const { cueRoutes } = await import("./routes/cue-routes.js");
const { callRoute } = await import("./routes/route-harness.js");

before(async () => {
  await automationEngine.init();
});

after(async () => {
  // Retries: the engine's log store can still be writing as the last case returns.
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe("rules that could not be read", () => {
  for (const route of ["/api/cues/manifest", "/api/cues/states", "/api/cues/home-assistant.yaml"]) {
    it(`${route} fails rather than answering with no cues`, async () => {
      await assert.rejects(callRoute(cueRoutes, route), { name: "StoreReadError" });
    });
  }

  it("an edit is refused before it goes live", async () => {
    await assert.rejects(
      automationEngine.addRule({
        name: "projectors",
        enabled: true,
        trigger: { id: "pco.service-started", params: {} },
        conditions: [],
        action: { id: "log.message", params: { message: "x" } },
        cooldownSec: 0,
        oncePerService: false,
      }),
      { name: "StoreReadError" },
    );
    assert.deepEqual(automationEngine.listRules(), []);
  });
});
