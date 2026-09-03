// check-beta-only.mjs needs a real tag and real commit history to test — file
// overlap between a fix and a feat commit is not something a pure-function
// unit test can fake convincingly, so this builds throwaway git repos in a
// tmp dir and drives the script's exported logic against them directly.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { findBetaOnlyCandidates } from "./check-beta-only.mjs";

const repos: string[] = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "beta-only-test-"));
  repos.push(dir);
  run(dir, ["init", "-q", "-b", "main"]);
  run(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["config", "user.name", "Test"]);
  return dir;
}

function run(dir: string, args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function writeFile(dir: string, path: string, contents: string) {
  execFileSync("mkdir", ["-p", join(dir, path.split("/").slice(0, -1).join("/") || ".")]);
  execFileSync("bash", ["-c", `cat > "${join(dir, path)}"`], { input: contents });
}

function commit(dir: string, path: string, contents: string, message: string) {
  writeFile(dir, path, contents);
  run(dir, ["add", path]);
  run(dir, ["commit", "-q", "-m", message]);
  return run(dir, ["rev-parse", "HEAD"]).trim();
}

function commitWithBody(dir: string, path: string, contents: string, subject: string, body: string) {
  writeFile(dir, path, contents);
  run(dir, ["add", path]);
  run(dir, ["commit", "-q", "-m", subject, "-m", body]);
  return run(dir, ["rev-parse", "HEAD"]).trim();
}

after(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function inRepo<T>(dir: string, fn: () => T): T {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
}

describe("findBetaOnlyCandidates", () => {
  it("flags a fix that shares a file with a feat since the stable tag, naming the feat", () => {
    const dir = makeRepo();
    commit(dir, "old.txt", "old", "chore: seed");
    run(dir, ["tag", "v1.0.0"]);
    commit(dir, "thing.txt", "new", "feat(thing): add the thing");
    commit(dir, "thing.txt", "fixed", "fix(thing): a bug in the new thing");

    const flagged = inRepo(dir, () => findBetaOnlyCandidates("v1.0.0", "v1.0.0"));
    assert.equal(flagged.length, 1);
    assert.match(flagged[0].subject, /^fix\(thing\)/);
    assert.equal(flagged[0].sharedWith.length, 1);
    assert.equal(flagged[0].sharedWith[0].file, "thing.txt");
    assert.match(flagged[0].sharedWith[0].subject, /^feat\(thing\)/);
  });

  it("does not flag the same commit with a Beta-only: true trailer", () => {
    const dir = makeRepo();
    commit(dir, "old.txt", "old", "chore: seed");
    run(dir, ["tag", "v1.0.0"]);
    commit(dir, "thing.txt", "new", "feat(thing): add the thing");
    commitWithBody(dir, "thing.txt", "fixed", "fix(thing): a bug in the new thing", "Beta-only: true");

    const flagged = inRepo(dir, () => findBetaOnlyCandidates("v1.0.0", "v1.0.0"));
    assert.equal(flagged.length, 0);
  });

  it("does not flag a fix touching only files no feat commit touched", () => {
    const dir = makeRepo();
    commit(dir, "old.txt", "old", "chore: seed");
    run(dir, ["tag", "v1.0.0"]);
    commit(dir, "thing.txt", "new", "feat(thing): add the thing");
    commit(dir, "unrelated.txt", "fixed", "fix(other): a bug nothing feat touched");

    const flagged = inRepo(dir, () => findBetaOnlyCandidates("v1.0.0", "v1.0.0"));
    assert.equal(flagged.length, 0);
  });

  it("never flags a feat: commit itself", () => {
    const dir = makeRepo();
    commit(dir, "old.txt", "old", "chore: seed");
    run(dir, ["tag", "v1.0.0"]);
    commit(dir, "thing.txt", "new", "feat(thing): add the thing");

    const flagged = inRepo(dir, () => findBetaOnlyCandidates("v1.0.0", "v1.0.0"));
    assert.equal(flagged.length, 0);
  });

  it("counts a feat that landed before base-ref but after the stable tag", () => {
    // The important case: base-ref is often a PR branch point partway through
    // the cycle, but the feature it shares code with may have merged earlier
    // in the same cycle, before base. Scanning stable..HEAD for feat commits
    // (not base..HEAD) is what catches this.
    const dir = makeRepo();
    commit(dir, "old.txt", "old", "chore: seed");
    run(dir, ["tag", "v1.0.0"]);
    commit(dir, "thing.txt", "new", "feat(thing): add the thing");
    const base = run(dir, ["rev-parse", "HEAD"]).trim();
    commit(dir, "thing.txt", "fixed", "fix(thing): a bug in the earlier feature");

    const flagged = inRepo(dir, () => findBetaOnlyCandidates(base, "v1.0.0"));
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].sharedWith[0].file, "thing.txt");
  });
});

describe("no stable tag", () => {
  it("the script exits 0 and reports nothing to compare against", () => {
    const dir = makeRepo();
    commit(dir, "old.txt", "old", "chore: seed");
    commit(dir, "new.txt", "new", "fix: a bug with no stable tag at all");

    const out = execFileSync(
      "node",
      [join(process.cwd(), "scripts/check-beta-only.mjs"), "HEAD~1"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.match(out, /No stable tag/);
  });
});

describe("exit code", () => {
  it("is always 0, even when a commit is flagged", () => {
    const dir = makeRepo();
    commit(dir, "old.txt", "old", "chore: seed");
    run(dir, ["tag", "v1.0.0"]);
    commit(dir, "thing.txt", "new", "feat(thing): add the thing");
    commit(dir, "thing.txt", "fixed", "fix(thing): a bug in the new thing");

    const result = execFileSync(
      "node",
      [join(process.cwd(), "scripts/check-beta-only.mjs"), "v1.0.0"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.match(result, /fix\(thing\): a bug in the new thing/);
    // execFileSync throws on non-zero exit, so reaching here already proves
    // exit 0. Assert the flagged line is present too, so a script that
    // silently found nothing does not pass this test by accident.
  });
});
