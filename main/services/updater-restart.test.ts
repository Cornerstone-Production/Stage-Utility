// A restart refused mid-update must not consume the pending-restart marker.
//
// The guard sat BELOW the removal, so pressing Restart while an update was
// running deleted the marker and then threw. No restart happened, but
// isRestartPending() answered false from then on, so the UI stopped offering the
// restart the update was still waiting for — leaving a shell as the only way to
// finish applying it.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "stage-updater-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { updater } = await import("./updater.js");

const MARKER = path.join(TMP, "update-restart-pending");
type Probe = { status: { phase: string; step?: string | null } };
const u = updater as unknown as Probe & { restart(): unknown; getStatus(): { restartPending: boolean } };

describe("restart while an update is running", () => {
  beforeEach(() => {
    fs.writeFileSync(MARKER, "");
    u.status = { ...u.status, phase: "updating", step: "install" };
  });

  it("refuses, and leaves the pending marker intact", () => {
    assert.throws(() => u.restart(), /already running/);
    assert.ok(fs.existsSync(MARKER), "the pending-restart marker was consumed by a refused restart");
  });

  it("still reports the restart as pending afterwards", () => {
    try {
      u.restart();
    } catch {
      /* expected */
    }
    assert.equal(u.getStatus().restartPending, true, "the UI would stop offering the restart");
  });

  it("consumes the marker when the restart is actually taken", () => {
    // restart() schedules a real process.exit once it commits. Test files are
    // process-isolated so it does not reach the other suites, but leaving a live
    // exit timer in a test is a trap for whoever runs this next.
    const realExit = process.exit;
    (process as unknown as { exit: unknown }).exit = () => undefined;
    try {
      u.status = { ...u.status, phase: "idle", step: null };
      u.restart();
      assert.equal(fs.existsSync(MARKER), false, "a taken restart should clear the marker");
    } finally {
      (process as unknown as { exit: unknown }).exit = realExit;
    }
  });
});
