// What a request that restarts the server answers with.
//
// The config import and snapshot recall used to reply `{ ok, applied, restarting }`
// and then schedule the exit, so a server that could not arrange its own relaunch
// (macOS, no launchd job it recognises) said "restarting" and went dark. The
// reply now carries `relaunchFailure` when that is so, and nothing extra when it
// is not, so clients that read only the old three fields are unaffected.
//
// Not covered here: that the two routes pass scheduleRestart()'s result in. That
// needs a darwin tarball install and would call launchctl on the machine running
// the tests; the types do force the argument (restartResponse takes a
// RelaunchPrep), and the failure itself is tested in relaunch.test.ts.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restart-response-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { restartResponse } = await import("./system-routes.js");

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("restartResponse", () => {
  it("keeps the shape clients already read when the relaunch is arranged", () => {
    const body = restartResponse({ files: 3 }, { plan: null, job: null, failure: null });
    assert.deepEqual(body, { ok: true, applied: { files: 3 }, restarting: true });
    assert.equal("relaunchFailure" in body, false, "no key at all, not an undefined one");
  });

  it("says so, with the reason, when the server could not arrange its relaunch", () => {
    const body = restartResponse({}, { plan: null, job: null, failure: "no known launchd job is running this server" });
    assert.equal(body.ok, true);
    assert.equal(body.restarting, true);
    assert.equal(body.relaunchFailure, "no known launchd job is running this server");
  });
});
