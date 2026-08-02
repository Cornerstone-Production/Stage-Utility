import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectTrack } from "./detect-track.js";

const base = { kind: "homebrew" as const, appRoot: "", version: "1.10.0-beta.4", gitBranch: null };

describe("detectTrack", () => {
  it("reads a Homebrew install's track off the formula it is installed from", () => {
    // The exact bug: this install runs beta, and reported main because the
    // updater read Homebrew's own git branch.
    const beta = detectTrack({
      ...base,
      appRoot: "/opt/homebrew/Cellar/stage-utility-beta/1.10.0-beta.4/libexec",
    });
    assert.deepEqual(beta, { track: "beta", source: "formula" });

    const main = detectTrack({
      ...base,
      appRoot: "/opt/homebrew/Cellar/stage-utility/1.9.5/libexec",
      version: "1.9.5",
    });
    assert.deepEqual(main, { track: "main", source: "formula" });
  });

  it("does not let the stable formula match inside the beta formula's name", () => {
    // "stage-utility" is a substring of "stage-utility-beta"; matching on a path
    // SEGMENT is what stops the stable formula winning by being checked first.
    const r = detectTrack({
      ...base,
      appRoot: "/opt/homebrew/Cellar/stage-utility-beta/1.10.0-beta.4/libexec",
    });
    assert.equal(r.track, "beta");
  });

  it("handles Windows-style separators in the keg path", () => {
    const r = detectTrack({ ...base, appRoot: "C:\\brew\\Cellar\\stage-utility-beta\\1.0.0\\libexec" });
    assert.equal(r.track, "beta");
  });

  it("infers a tarball's track from whether its version is a prerelease", () => {
    assert.deepEqual(detectTrack({ ...base, kind: "tarball", version: "1.10.0-beta.4" }), {
      track: "beta",
      source: "version",
    });
    assert.deepEqual(detectTrack({ ...base, kind: "tarball", version: "1.9.5" }), {
      track: "main",
      source: "version",
    });
  });

  it("uses the checked-out branch for a git install, and only there", () => {
    assert.deepEqual(detectTrack({ ...base, kind: "git", gitBranch: "beta" }), {
      track: "beta",
      source: "git",
    });
    // A packaged install must never adopt a branch: every Homebrew install sits
    // inside Homebrew's own git repository, whose branch is main.
    const brewInsideGit = detectTrack({
      ...base,
      appRoot: "/opt/homebrew/Cellar/stage-utility-beta/1.10.0-beta.4/libexec",
      gitBranch: "main",
    });
    assert.equal(brewInsideGit.track, "beta");
  });

  it("falls back to the version when a keg sits somewhere unexpected", () => {
    const r = detectTrack({ ...base, appRoot: "/somewhere/else/libexec" });
    assert.deepEqual(r, { track: "beta", source: "version" });
  });

  it("answers unknown rather than guessing main", () => {
    // Defaulting to main is the bug being fixed: it is confidently wrong, and
    // nothing on screen suggests the value was invented.
    assert.deepEqual(detectTrack({ ...base, kind: "unknown", version: "0.0.0" }), {
      track: null,
      source: "unknown",
    });
    assert.deepEqual(detectTrack({ ...base, kind: "git", gitBranch: null }), {
      track: null,
      source: "unknown",
    });
    assert.deepEqual(detectTrack({ ...base, kind: "tarball", version: "0.0.0" }), {
      track: null,
      source: "unknown",
    });
  });
});
