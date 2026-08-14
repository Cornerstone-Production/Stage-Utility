// An apply that dies without reporting must not strand the UI.
//
// Drives the REAL updater: its own applyUpdate, its own launch, its own 1s
// progress poller, its own result file. Only two things are replaced — the
// spawn (so no installer actually runs) and the stall timeout (so the test
// takes a moment rather than ten minutes). The child it "spawns" writes
// nothing at all, which is exactly what happened on a real box when the
// script's working directory was deleted underneath it.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "stage-stall-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { Updater } = await import("./updater.js");
const { parseReleases } = await import("./update/release-check.js");

const RELEASES = parseReleases([
  { tag_name: "v1.10.0-beta.31", name: "v1.10.0-beta.31", draft: false, published_at: "2026-08-13T00:00:00Z" },
  { tag_name: "v1.10.0-beta.30", name: "v1.10.0-beta.30", draft: false, published_at: "2026-08-12T00:00:00Z" },
]);

/** git as a packaged install sees it. */
async function noRepoGit(args: string[]): Promise<string> {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") throw new Error("not a git repository");
  throw new Error(`unexpected git call: ${args.join(" ")}`);
}

/** A child that starts and then never writes a progress, log, or result file. */
const deadSpawn = (() =>
  ({ unref() {}, on() {}, once() {} }) as unknown as ReturnType<typeof import("node:child_process").spawn>) as never;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const resultFile = () => path.join(TMP, "update-result.json");

describe("an apply that never reports", () => {
  let savedKind: string | undefined;
  before(() => {
    savedKind = process.env.STAGE_UTILITY_INSTALL_KIND;
    process.env.STAGE_UTILITY_INSTALL_KIND = "tarball";
  });
  after(async () => {
    if (savedKind === undefined) delete process.env.STAGE_UTILITY_INSTALL_KIND;
    else process.env.STAGE_UTILITY_INSTALL_KIND = savedKind;
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  it("drops out of the updating phase and records why", async () => {
    const u = new Updater({
      git: noRepoGit,
      fetchReleases: async () => RELEASES,
      version: () => "1.10.0-beta.30",
      spawn: deadSpawn,
      stallMs: 40,
    });

    await u.checkForUpdate();
    const started = await u.applyUpdate();
    assert.equal(started.phase, "updating", "the apply must actually start");

    // Longer than the stall window plus a poll tick.
    await settle(1400);

    const after = u.getStatus();
    assert.equal(after.phase, "idle", "must not sit in 'updating' after a silent run — this is the bug");
    assert.equal(after.step, null);

    // The verdict has to outlive this process's memory, or a reload finds the
    // page cheerfully waiting again.
    assert.ok(fs.existsSync(resultFile()), "must write a result file");
    const recorded = JSON.parse(fs.readFileSync(resultFile(), "utf8")) as { ok: boolean; log: string };
    assert.equal(recorded.ok, false);
    assert.match(recorded.log, /stopped responding/i, "must say what happened, in the operator's terms");
    assert.match(recorded.log, /still running the current version/i, "and that the box is not broken");
  });
});
