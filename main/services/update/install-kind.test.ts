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

  it("returns unknown for an unrecognised location", () => {
    assert.equal(detectInstallKind({}, "/home/someone/scratch", noFiles), "unknown");
  });
});
