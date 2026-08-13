import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Updater } from "./updater.js";
import { parseReleases } from "./update/release-check.js";

// The regression this file guards: `checkForUpdate` on a packaged install used
// to set the track and stop. `behind` stayed 0 forever, the UI said "Up to
// date" with the Update button disabled, and the hourly auto-apply never fired
// — on every curl/Homebrew install, while the strategy layer sat behind it
// fully able to apply an update. Proven red against that code by reverting the
// checkForUpdate wiring: every "learns what is newest" assertion below fails.
//
// These tests run the REAL checkForUpdate path. The seams only replace what a
// packaged install genuinely lacks: git answers "this is not a checkout", and
// the releases API answers with a canned response.

const RELEASES = parseReleases([
  { tag_name: "v1.10.0-beta.27", name: "v1.10.0-beta.27", draft: false, published_at: "2026-08-13T00:00:00Z" },
  { tag_name: "v1.10.0-beta.26", name: "v1.10.0-beta.26", draft: false, published_at: "2026-08-12T00:00:00Z" },
  { tag_name: "v1.9.5", name: "v1.9.5", draft: false, published_at: "2026-07-01T00:00:00Z" },
  { tag_name: "v1.9.4", name: "v1.9.4", draft: false, published_at: "2026-06-20T00:00:00Z" },
]);

/** git as a packaged install sees it: not a checkout, and nothing else works. */
const noRepoGit = async (args: string[]): Promise<string> => {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
    throw new Error("fatal: not a git repository");
  }
  throw new Error(`unexpected git call on a packaged install: git ${args.join(" ")}`);
};

describe("checkForUpdate on a packaged install", () => {
  let savedKind: string | undefined;
  beforeEach(() => {
    savedKind = process.env.STAGE_UTILITY_INSTALL_KIND;
    process.env.STAGE_UTILITY_INSTALL_KIND = "tarball";
  });
  afterEach(() => {
    if (savedKind === undefined) delete process.env.STAGE_UTILITY_INSTALL_KIND;
    else process.env.STAGE_UTILITY_INSTALL_KIND = savedKind;
  });

  it("learns what is newest from the releases API — the bug was learning nothing", async () => {
    const u = new Updater({
      git: noRepoGit,
      fetchReleases: async () => RELEASES,
      version: () => "1.10.0-beta.26",
    });
    const s = await u.checkForUpdate();

    assert.equal(s.isGitRepo, false);
    assert.equal(s.branch, "beta", "track inferred from the prerelease version");
    assert.equal(s.targetTag, "v1.10.0-beta.27");
    assert.equal(s.releasesBehind, 1);
    assert.ok((s.behind ?? 0) > 0, "auto-apply gates on behind; 0 means it never fires");
    assert.equal(s.tagBased, true, "the UI's release banner reads the tag-based fields");
    assert.equal(s.canUpdate, true);
    assert.equal(s.error, null);
  });

  it("a main-track box compares against stable releases only", async () => {
    const u = new Updater({
      git: noRepoGit,
      fetchReleases: async () => RELEASES,
      version: () => "1.9.4",
    });
    const s = await u.checkForUpdate();
    assert.equal(s.branch, "main");
    assert.equal(s.targetTag, "v1.9.5");
    assert.equal(s.releasesBehind, 1);
  });

  it("up to date reads as zero, so the banner stays quiet", async () => {
    const u = new Updater({
      git: noRepoGit,
      fetchReleases: async () => RELEASES,
      version: () => "1.10.0-beta.27",
    });
    const s = await u.checkForUpdate();
    assert.equal(s.releasesBehind, 0);
    assert.equal(s.behind, 0);
    assert.equal(s.error, null);
  });

  it("a failed release check reports the error and stays idle — never silently 'up to date'", async () => {
    const u = new Updater({
      git: noRepoGit,
      fetchReleases: async () => {
        throw new Error("Release check failed: GitHub answered 403");
      },
      version: () => "1.9.4",
    });
    const s = await u.checkForUpdate();
    assert.equal(s.phase, "idle");
    assert.match(s.error ?? "", /403/);
    assert.equal(s.lastCheckedAt === null, false);
  });
});
