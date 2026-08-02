import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INSTALLER_PS1, INSTALLER_SH, TarballStrategy } from "./tarball-strategy.js";

const base = { track: "main", checkout: false, deferRestart: false, version: null, env: {} };

describe("TarballStrategy", () => {
  it("always asks the installer for swap mode, so the service is never stopped first", () => {
    for (const platform of ["linux", "darwin", "win32"] as NodeJS.Platform[]) {
      const p = new TarballStrategy(platform).plan(base);
      assert.equal(p.env.STAGE_UPDATE_MODE, "swap", `${platform} must use swap mode`);
    }
  });

  it("never reaches for systemd-run: nothing stops the unit, so there is no cgroup to escape", () => {
    const p = new TarballStrategy("linux").plan(base);
    assert.equal(p.command, "bash");
    assert.ok(!p.args.join(" ").includes("systemd-run"), "swap mode removes the need for a scope");
  });

  it("runs the same shape on Linux and macOS", () => {
    assert.deepEqual(
      new TarballStrategy("linux").plan(base).args,
      new TarballStrategy("darwin").plan(base).args,
    );
  });

  it("can always apply, because it has no external prerequisite", () => {
    assert.equal(new TarballStrategy("linux").canApply().ok, true);
  });

  it("fetches the current installer rather than running a local copy", () => {
    const p = new TarballStrategy("darwin").plan(base);
    assert.ok(p.args.join(" ").includes(INSTALLER_SH), "must curl the published installer");
  });

  it("carries the track, and a pinned version only when one is given", () => {
    const s = new TarballStrategy("darwin");
    assert.equal(s.plan({ ...base, track: "beta" }).env.STAGE_TRACK, "beta");
    assert.equal(s.plan(base).env.STAGE_VERSION, undefined);
    assert.equal(s.plan({ ...base, version: "v1.9.6" }).env.STAGE_VERSION, "v1.9.6");
  });

  it("uses PowerShell and the ps1 installer on Windows", () => {
    const p = new TarballStrategy("win32").plan(base);
    assert.equal(p.command, "powershell.exe");
    assert.ok(p.args.join(" ").includes(INSTALLER_PS1));
    assert.ok(!p.args.join(" ").includes(INSTALLER_SH), "must not fetch the bash installer");
  });

  it("preserves the protocol env the updater passed in", () => {
    // The installer reports progress through these; dropping them would leave the
    // UI with nothing to poll and no way to leave the updating phase.
    const env = { STAGE_UPDATE_PROGRESS: "/tmp/p.json", STAGE_UPDATE_RESULT: "/tmp/r.json" };
    const p = new TarballStrategy("linux").plan({ ...base, env });
    assert.equal(p.env.STAGE_UPDATE_PROGRESS, "/tmp/p.json");
    assert.equal(p.env.STAGE_UPDATE_RESULT, "/tmp/r.json");
  });
});
