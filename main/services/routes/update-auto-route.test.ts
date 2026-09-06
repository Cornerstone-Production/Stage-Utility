// POST /api/update/auto — setting the update mode.
//
// Found while driving the Advanced tab's redesigned Updates control in a
// browser: choosing "Install" or "Install + restart" silently did nothing.
// The route rebuilt its partial from `enabled`/`dayOfWeek`/`hour` only —
// `mode`, the one field the client actually sends when a person picks a
// different mode, was never copied. The response still came back 200 with a
// full state, so nothing in the UI or a shallow "did it 200" test would have
// caught it; only asserting the field survived does.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-update-auto-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { systemRoutes } = await import("./system-routes.js");
const { callRoute } = await import("./route-harness.js");

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("POST /api/update/auto", () => {
  it("persists a new mode, not just enabled/dayOfWeek/hour", async () => {
    const out = await callRoute(systemRoutes, "/api/update/auto", {
      method: "POST",
      body: { mode: "auto-install" },
    });
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    const state = out.json as { autoUpdate?: { mode?: string } };
    assert.equal(
      state.autoUpdate?.mode,
      "auto-install",
      "the mode the client sent must be the mode that comes back",
    );
  });

  it("rejects a mode that is not one of the three known values", async () => {
    const out = await callRoute(systemRoutes, "/api/update/auto", {
      method: "POST",
      body: { mode: "yolo" },
    });
    assert.equal(out.status, 200);
    const state = out.json as { autoUpdate?: { mode?: string } };
    assert.notEqual(state.autoUpdate?.mode, "yolo", "a bogus mode must not be stored verbatim");
  });
});
