// The helper's one promise: the dir exists while the file runs and is gone
// after it. Checked from outside, on a child process that has already exited.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("tempDataDir sets the env, then removes the dir when the file ends", () => {
  const scratch = mkdtempSync(join(tmpdir(), "temp-data-dir-test-"));
  try {
    const report = join(scratch, "report.json");
    const probe = join(import.meta.dirname, "temp-data-dir-probe.ts");
    // NODE_TEST_CONTEXT would make the child skip running its tests.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const run = spawnSync(process.execPath, ["--test", "--import", "tsx", probe], {
      env: { ...env, PROBE_REPORT: report },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const seen = JSON.parse(readFileSync(report, "utf8")) as { dir: string; env: string; home: string };
    assert.equal(seen.env, seen.dir);
    assert.equal(seen.home, join(seen.dir, "home"));
    assert.ok(seen.dir.startsWith(tmpdir()) || seen.dir.includes("temp-data-dir-probe-"), seen.dir);
    assert.equal(existsSync(seen.dir), false, `${seen.dir} was left behind`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
