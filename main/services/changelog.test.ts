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
      ["feat(patch): rack color on its header", "fix(history): energy-average SPL", "perf(sse): broadcast only on change"],
    );
  });

  test("developer-only work is filtered out", () => {
    for (const t of ["chore", "ci", "build", "docs", "test", "refactor", "style"]) {
      assert.deepEqual(summarizeChangelog([`${t}: something`]), [], t);
      assert.deepEqual(summarizeChangelog([`${t}(scope): something`]), [], `${t} with scope`);
    }
  });

  test("a breaking marker does not hide the entry", () => {
    assert.deepEqual(summarizeChangelog(["feat(types)!: rename a field"]), ["feat(types)!: rename a field"]);
  });

  test("a revert is something a user notices", () => {
    assert.deepEqual(summarizeChangelog(['revert: "feat: add thing"']), ['revert: "feat: add thing"']);
  });

  test("an unrecognised subject is kept, not hidden", () => {
    // Better to show something odd than to swallow a real change.
    assert.deepEqual(summarizeChangelog(["hotfix applied by hand"]), ["hotfix applied by hand"]);
  });

  test("CI directives are stripped from what is shown", () => {
    assert.deepEqual(summarizeChangelog(["fix: a thing [skip ci]"]), ["fix: a thing"]);
    assert.deepEqual(summarizeChangelog(["fix: a thing [ci skip]"]), ["fix: a thing"]);
  });

  test("the same subject twice shows once", () => {
    assert.deepEqual(summarizeChangelog(["fix: same", "fix: same"]), ["fix: same"]);
  });

  test("order is preserved — newest first, as git gave them", () => {
    assert.deepEqual(summarizeChangelog(["fix: b", "feat: a"]), ["fix: b", "feat: a"]);
  });

  test("the cap counts what is shown, not what was considered", () => {
    const noise = Array.from({ length: 50 }, (_, i) => `chore: noise ${i}`);
    const real = Array.from({ length: 5 }, (_, i) => `fix: real ${i}`);
    assert.deepEqual(summarizeChangelog([...noise, ...real], 3), ["fix: real 0", "fix: real 1", "fix: real 2"]);
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
    assert.deepEqual(summarizeChangelog(["", "   ", "fix: real"]), ["fix: real"]);
  });
});
