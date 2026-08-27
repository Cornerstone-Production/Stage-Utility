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
import { describe, it } from "node:test";

import { subjectIsValid } from "./check-commit-subjects.mjs";

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
  it("accepts every allowed type", () => {
    for (const t of ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"]) {
      assert.equal(subjectIsValid(`${t}: something`), true, `${t} must be allowed`);
    }
  });

  it("accepts an optional lower-case scope and a breaking marker", () => {
    assert.equal(subjectIsValid("feat(patch): rack colour on its header card"), true);
    assert.equal(subjectIsValid("feat(types)!: rename Slot.channel to Slot.channelId"), true);
    assert.equal(subjectIsValid("fix!: drop a field"), true);
    assert.equal(subjectIsValid("fix(main/services): a path-like scope"), true);
  });

  it("rejects an unknown type, an upper-case scope, and a missing subject", () => {
    assert.equal(subjectIsValid("wip: half a thing"), false);
    assert.equal(subjectIsValid("fix(Editor): capitalised scope"), false);
    assert.equal(subjectIsValid("fix:"), false);
    assert.equal(subjectIsValid("just a sentence"), false);
  });

  it("accepts what git revert generates", () => {
    // Not reworded on purpose: fixing one after it is pushed means rewriting the
    // branch, and beta and main are never force-pushed.
    assert.equal(subjectIsValid('Revert "feat(patch): rack colour on its header card"'), true);
  });
});
