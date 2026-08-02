import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectInstallKind } from "./install-kind.js";

const noFiles = () => false;

describe("detectInstallKind", () => {
  it("prefers a declared kind over anything inferable", () => {
    const env = { STAGE_UTILITY_INSTALL_KIND: "homebrew" } as NodeJS.ProcessEnv;
    assert.equal(detectInstallKind(env, "/opt/stage-utility", noFiles), "homebrew");
  });

  it("rejects a declared kind that is not a known value", () => {
    const env = { STAGE_UTILITY_INSTALL_KIND: "nonsense" } as NodeJS.ProcessEnv;
    assert.equal(detectInstallKind(env, "/srv/app", noFiles), "unknown");
  });

  it("calls a checkout with a .git directory git", () => {
    const exists = (p: string) => p === "/srv/app/.git";
    assert.equal(detectInstallKind({}, "/srv/app", exists), "git");
  });

  it("infers homebrew from a Cellar path when nothing is declared", () => {
    const root = "/opt/homebrew/Cellar/stage-utility/1.9.5/libexec";
    assert.equal(detectInstallKind({}, root, noFiles), "homebrew");
  });

  it("infers tarball from each documented install prefix", () => {
    assert.equal(detectInstallKind({}, "/opt/stage-utility", noFiles), "tarball");
    assert.equal(detectInstallKind({}, "/usr/local/stage-utility", noFiles), "tarball");
    assert.equal(detectInstallKind({}, "C:\\Program Files\\Stage Utility", noFiles), "tarball");
  });

  it("infers tarball for a Windows install in a subdirectory of the prefix", () => {
    const root = "C:\\Program Files\\Stage Utility\\current";
    assert.equal(detectInstallKind({}, root, noFiles), "tarball");
  });

  it("returns unknown for an unrecognised location", () => {
    assert.equal(detectInstallKind({}, "/home/someone/scratch", noFiles), "unknown");
  });

  it("prefers git over a tarball prefix when both are present", () => {
    const root = "/opt/stage-utility";
    const exists = (p: string) => p === `${root}/.git`;
    assert.equal(detectInstallKind({}, root, exists), "git");
  });

  it("does not treat a prefix substring as a path segment match", () => {
    assert.equal(detectInstallKind({}, "/opt/stage-utility-other", noFiles), "unknown");
  });
});

describe("Homebrew keg detection covers every published formula", () => {
  it("recognises the beta formula's keg, not just the stable one", () => {
    // This matched only "/Cellar/stage-utility/", so every beta install detected
    // as "unknown" and could select no update strategy at all.
    for (const formula of ["stage-utility", "stage-utility-beta"]) {
      const root = `/opt/homebrew/Cellar/${formula}/1.10.0-beta.4/libexec`;
      assert.equal(detectInstallKind({}, root, () => false), "homebrew", `${formula} must be homebrew`);
    }
  });

  it("does not mistake a similarly-named keg for one of ours", () => {
    assert.equal(
      detectInstallKind({}, "/opt/homebrew/Cellar/stage-utility-other/1.0.0/libexec", () => false),
      "unknown",
    );
  });
});
