// The commit-subject rule, tested on the subjects that actually failed.
//
// This convention was enforced only in CI, so the first time a bad subject was
// seen was after a push. That happened three times in one week and twice for the
// SAME reason: a scope with a comma and a space, which the pattern cannot admit
// because scopes are `[a-z0-9.+/-]`.
//
// Both of those real subjects are below. A rule whose test does not contain the
// input that broke it is a rule nobody has checked.
//
// The workflow calls the same module, so this cannot pass while CI disagrees —
// which is the other half of why the pattern moved out of the YAML.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import COMMIT_TYPE_FILE from "../main/services/commit-types.json" with { type: "json" };
import { subjectIsValid } from "./check-commit-subjects.mjs";

// The types are main/services/commit-types.json's: the tests below loop over what
// it says, so a type added there is covered the day it is added.
const BREAKABLE = [...COMMIT_TYPE_FILE.minor, ...COMMIT_TYPE_FILE.patch, ...COMMIT_TYPE_FILE.invisible];
const ALL_TYPES = [...BREAKABLE, ...COMMIT_TYPE_FILE.revert];

describe("commit subjects that were rejected in CI", () => {
  it("rejects a scope containing a comma and a space", () => {
    // Both of these were pushed and failed. They are the reason this file exists.
    assert.equal(subjectIsValid("fix(slots, transcript): faces and a stuck line"), false);
    assert.equal(subjectIsValid("fix(editor, resi): re-measure on selection"), false);
  });

  it("accepts the reworded forms that replaced them", () => {
    assert.equal(subjectIsValid("fix(slots): faces behind name cards"), true);
    assert.equal(subjectIsValid("fix(editor): re-measure on selection"), true);
  });
});

describe("the convention itself", () => {
  it("accepts every type the shared list names", () => {
    for (const t of ALL_TYPES) {
      assert.equal(subjectIsValid(`${t}: something`), true, `${t} must be allowed`);
    }
  });

  it("accepts an optional lower-case scope and a breaking marker", () => {
    for (const t of BREAKABLE) {
      assert.equal(subjectIsValid(`${t}(patch): something`), true, `${t} with a scope`);
      assert.equal(subjectIsValid(`${t}!: something`), true, `${t}!`);
      assert.equal(subjectIsValid(`${t}(patch)!: something`), true, `${t} with a scope, breaking`);
    }
    assert.equal(subjectIsValid("fix(main/services): a path-like scope"), true);
  });

  it("takes no breaking marker on a revert", () => {
    // A revert releases nothing, so a breaking one would head the notes' Breaking
    // list while the release level said there was nothing to release.
    for (const t of COMMIT_TYPE_FILE.revert) {
      assert.equal(subjectIsValid(`${t}!: something`), false, `${t}!`);
      assert.equal(subjectIsValid(`${t}(patch)!: something`), false, `${t} with a scope, breaking`);
    }
  });

  it("rejects an unknown type, an upper-case scope, and a missing subject", () => {
    assert.equal(subjectIsValid("wip: half a thing"), false);
    assert.equal(subjectIsValid("fix(Editor): capitalised scope"), false);
    assert.equal(subjectIsValid("fix:"), false);
    assert.equal(subjectIsValid("just a sentence"), false);
  });

  it("refuses a legacy type, which only old history carries", () => {
    for (const t of COMMIT_TYPE_FILE.legacy) {
      assert.equal(subjectIsValid(`${t}: tidy the header`), false, t);
      assert.equal(subjectIsValid(`${t}(patch): tidy the header`), false, `${t} with a scope`);
    }
  });

  it("accepts what git revert generates", () => {
    // Not reworded on purpose: fixing one after it is pushed means rewriting the
    // branch, and beta and main are never force-pushed.
    assert.equal(subjectIsValid('Revert "feat(patch): rack colour on its header card"'), true);
  });
});

describe("what the lint tells an author whose subject it rejects", () => {
  it("offers exactly the types the shared list names", () => {
    // The real script over a real bad commit: its message is a second place the
    // list could be written out by hand.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-subjects-"));
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "chore: seed");
      git("tag", "base");
      git("commit", "-q", "--allow-empty", "-m", "wip: half a thing");

      const script = fileURLToPath(new URL("./check-commit-subjects.mjs", import.meta.url));
      const r = spawnSync("node", [script, "base"], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 1, r.stdout);
      const offered = /type must be one of:\n\s+(.+)\n/.exec(r.stderr)?.[1].split(" ");
      assert.deepEqual([...(offered ?? [])].sort(), [...ALL_TYPES].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
