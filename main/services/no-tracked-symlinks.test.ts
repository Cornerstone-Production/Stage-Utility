// Nothing in this repository is a symlink, and one slipping in is not cosmetic.
//
// A `node_modules` symlink pointing at `/Users/<someone>/projects/stage-utility`
// was committed to beta by an agent's `git add -A`. Two things let it through,
// and both are fixed here:
//
//  - `.gitignore` said `node_modules/` WITH a trailing slash, which matches a
//    directory and not a symlink of the same name. It now has no slash.
//  - nothing checked. A tracked symlink to an absolute path is broken for every
//    other clone, leaks a developer's filesystem layout into a public repo, and
//    on checkout git tries to replace a real directory with it.
//
// Asserted as EXACTLY ZERO rather than "no node_modules": the next one will have
// a different name, and a floor with slack is how this class of thing recurs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, describe } from "node:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("tracked file modes", () => {
  test("no tracked path is a symlink", () => {
    // Mode 120000 is git's symlink mode. Reading the index rather than the
    // filesystem, so this fails on what would be COMMITTED, not on whatever the
    // working tree happens to hold.
    const out = execFileSync("git", ["ls-files", "-s"], { cwd: repoRoot, encoding: "utf8" });
    const symlinks = out
      .split("\n")
      .filter((l) => l.startsWith("120000"))
      .map((l) => l.split("\t")[1])
      .filter(Boolean);

    assert.deepEqual(
      symlinks,
      [],
      `tracked symlink(s) found: ${symlinks.join(", ")}.\n` +
        "  A symlink to an absolute path is broken in every other clone and leaks\n" +
        "  a filesystem layout into a public repo. If one is ever legitimate here,\n" +
        "  add it to this test deliberately rather than widening the assertion.",
    );
  });

  test("nothing tracked is also gitignored", () => {
    // The other half of the same mistake: a file that .gitignore claims to
    // exclude but which is tracked anyway, so the ignore rule silently does
    // nothing and the next `git add -A` keeps it.
    const out = execFileSync("git", ["ls-files", "-i", "-c", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const tracked = out.split("\n").filter(Boolean);
    assert.deepEqual(tracked, [], `tracked but gitignored: ${tracked.join(", ")}`);
  });
});
