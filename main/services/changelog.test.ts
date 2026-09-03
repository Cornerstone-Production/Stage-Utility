import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { summarizeChangelog } from "./changelog.js";

describe("summarizeChangelog", () => {
  test("the release workflow's own version bump is not news", () => {
    // The exact subject that prompted this: an update whose only listed change
    // was the version number being written down.
    assert.deepEqual(summarizeChangelog(["chore(release): v1.4.3-beta.1 [skip ci]"]), []);
  });

  test("merge commits are not news either", () => {
    assert.deepEqual(
      summarizeChangelog([
        "Merge pull request #151 from Cornerstone-Production/fix/tooltips",
        "Merge branch 'beta' into main",
      ]),
      [],
    );
  });

  test("what a user can tell apart survives", () => {
    assert.deepEqual(
      summarizeChangelog([
        "feat(patch): rack color on its header",
        "fix(history): energy-average SPL",
        "perf(sse): broadcast only on change",
      ]),
      // The TYPE goes and the SCOPE leads, which is how the published release
      // notes render the same commits — a checkout must not describe an update
      // differently from the release it is tracking.
      ["patch — rack color on its header", "history — energy-average SPL", "sse — broadcast only on change"],
    );
  });

  test("developer-only work is filtered out", () => {
    for (const t of ["chore", "ci", "build", "docs", "test", "refactor", "style"]) {
      assert.deepEqual(summarizeChangelog([`${t}: something`]), [], t);
      assert.deepEqual(summarizeChangelog([`${t}(scope): something`]), [], `${t} with scope`);
    }
  });

  test("a breaking marker does not hide the entry, and is not shortened away", () => {
    // The `!` is the only mark a breaking change gets. Shortening the line to
    // "types — rename a field" leaves the one entry an operator must not skim
    // past looking exactly like every other.
    assert.deepEqual(summarizeChangelog(["feat(types)!: rename a field"]), ["feat(types)!: rename a field"]);
    assert.deepEqual(summarizeChangelog(["fix!: drop the old path"]), ["fix!: drop the old path"]);
  });

  test("a revert keeps the word revert, which is the whole meaning", () => {
    // Shortened, this reads as the feature being ADDED. The line would announce
    // the opposite of what the update does.
    assert.deepEqual(summarizeChangelog(['revert: "feat: add thing"']), ['revert: "feat: add thing"']);
  });

  test("a scope nobody outside the repo would know is spelled out", () => {
    // a11y went out in 1.13.0's notes eight times. It means nothing to anyone
    // who has not written a commit message.
    assert.deepEqual(
      summarizeChangelog(["fix(a11y): the icon set opens from the keyboard"]),
      ["accessibility — the icon set opens from the keyboard"],
    );
    // A scope that already says what it is passes through untouched.
    assert.deepEqual(summarizeChangelog(["fix(scores): a thing"]), ["scores — a thing"]);
  });

  test("an unrecognised subject is kept, not hidden", () => {
    // Better to show something odd than to swallow a real change.
    assert.deepEqual(summarizeChangelog(["hotfix applied by hand"]), ["hotfix applied by hand"]);
  });

  test("CI directives are stripped from what is shown", () => {
    assert.deepEqual(summarizeChangelog(["fix: a thing [skip ci]"]), ["a thing"]);
    assert.deepEqual(summarizeChangelog(["fix: a thing [ci skip]"]), ["a thing"]);
  });

  test("the same subject twice shows once", () => {
    assert.deepEqual(summarizeChangelog(["fix: same", "fix: same"]), ["same"]);
  });

  test("order is preserved — newest first, as git gave them", () => {
    assert.deepEqual(summarizeChangelog(["fix: b", "feat: a"]), ["b", "a"]);
  });

  test("the cap counts what is shown, not what was considered", () => {
    const noise = Array.from({ length: 50 }, (_, i) => `chore: noise ${i}`);
    const real = Array.from({ length: 5 }, (_, i) => `fix: real ${i}`);
    assert.deepEqual(summarizeChangelog([...noise, ...real], 3), ["real 0", "real 1", "real 2"]);
  });

  test("a release carrying only invisible work lists nothing at all", () => {
    // The caller hides the panel rather than showing a heading over an empty list.
    assert.deepEqual(
      summarizeChangelog([
        "chore(release): v1.4.3-beta.1 [skip ci]",
        "Merge pull request #150 from Cornerstone-Production/feat/x",
        "ci: bump actions/checkout",
      ]),
      [],
    );
  });

  test("blank subjects are ignored", () => {
    assert.deepEqual(summarizeChangelog(["", "   ", "fix: real"]), ["real"]);
  });
});
