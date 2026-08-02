import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitStrategy } from "./git-strategy.js";

const all = () => true;
const base = { track: "beta", checkout: false, deferRestart: false, version: null, env: {} };

describe("GitStrategy", () => {
  it("refuses when the update script is missing", () => {
    const s = new GitStrategy("/srv/app", "linux", (p) => !p.endsWith("update.sh"));
    const r = s.canApply();
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; reason: string }).reason, /update\.sh/);
  });

  it("refuses when there is no checkout", () => {
    const s = new GitStrategy("/srv/app", "linux", (p) => !p.endsWith(".git"));
    assert.equal(s.canApply().ok, false);
  });

  it("applies when both the script and the checkout are present", () => {
    assert.equal(new GitStrategy("/srv/app", "linux", all).canApply().ok, true);
  });

  it("plans a bash spawn of the repo's update script", () => {
    const p = new GitStrategy("/srv/app", "linux", all).plan(base);
    assert.equal(p.command, "bash");
    assert.deepEqual(p.args, ["/srv/app/scripts/update.sh"]);
  });

  it("passes the checkout flag through only when switching tracks", () => {
    const s = new GitStrategy("/srv/app", "linux", all);
    assert.equal(s.plan({ ...base, checkout: true }).env.STAGE_UPDATE_CHECKOUT, "1");
    assert.equal(s.plan(base).env.STAGE_UPDATE_CHECKOUT, "");
  });

  it("carries the track, and a pinned version only when one is given", () => {
    const s = new GitStrategy("/srv/app", "linux", all);
    assert.equal(s.plan(base).env.STAGE_UPDATE_BRANCH, "beta");
    assert.equal(s.plan(base).env.STAGE_UPDATE_TAG, undefined);
    assert.equal(s.plan({ ...base, version: "v1.9.6" }).env.STAGE_UPDATE_TAG, "v1.9.6");
  });

  it("runs update.ps1 through PowerShell on Windows, not bash", () => {
    // Regression guard: a bash spawn of a .ps1 file fails instantly and, because
    // the child is detached with stdio ignored, silently.
    const p = new GitStrategy("C:\\app", "win32", all).plan(base);
    assert.equal(p.command, "powershell.exe");
    assert.ok(p.args.some((a) => a.endsWith("update.ps1")), "must point at the PowerShell script");
    assert.ok(!p.args.some((a) => a.endsWith("update.sh")), "must not point at the bash script");
  });
});
