import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installerUrl, TarballStrategy } from "./tarball-strategy.js";

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
    assert.ok(p.args.join(" ").includes(installerUrl("main", "darwin")), "must curl the published installer");
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
    assert.ok(p.args.join(" ").includes(installerUrl("main", "win32")));
    assert.ok(!p.args.join(" ").includes("install.sh"), "must not fetch the bash installer");
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

describe("TarballStrategy — the installer follows the track", () => {
  const urlIn = (track: string, platform: NodeJS.Platform) =>
    new TarballStrategy(platform).plan({ ...base, track }).args.join(" ");

  it("a beta install runs BETA's installer, not main's", () => {
    // main only moves when a release is cut, so an installer fix that shipped
    // to beta would not reach a beta box for days — and the missing fix may be
    // the one that lets it install at all. That happened: a SIGPIPE on the
    // larger beta release JSON broke beta installs, the fix shipped to beta,
    // and the next attempt failed identically on main's copy.
    assert.match(urlIn("beta", "linux"), /Stage-Utility\/beta\/install\.sh/);
    assert.match(urlIn("beta", "win32"), /Stage-Utility\/beta\/install\.ps1/);
  });

  it("a stable install still runs main's", () => {
    assert.match(urlIn("main", "linux"), /Stage-Utility\/main\/install\.sh/);
    assert.match(urlIn("main", "win32"), /Stage-Utility\/main\/install\.ps1/);
  });

  it("an unrecognised track falls back to main rather than a branch that may not exist", () => {
    assert.match(urlIn("nightly", "linux"), /Stage-Utility\/main\/install\.sh/);
  });

  it("switching tracks fetches the installer of the track being switched TO", () => {
    // The switch is what changes the box's track, so the installer that
    // performs it must be the incoming track's.
    const p = new TarballStrategy("darwin").plan({ ...base, track: "beta", checkout: true });
    assert.match(p.args.join(" "), /Stage-Utility\/beta\/install\.sh/);
  });
});
