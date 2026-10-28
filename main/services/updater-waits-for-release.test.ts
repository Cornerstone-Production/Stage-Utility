// The release workflow pushes a tag at once and publishes the GitHub release,
// with its notes and signed assets, about fifteen minutes later. A checkout that
// took the tag in that window showed an "Updated to" dialog with no grouped notes
// (it fell back to raw commit subjects) and pointed helpers at assets that did
// not exist yet.
//
// These drive the real checkForUpdate and the real apply pin (targetTagFor, via
// switchTrack's launch) over the two seams a test cannot have: git and the
// releases API. The merge-commit tests run REAL git in a temp repo.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";

import { Updater } from "./updater.js";
import { APP_ROOT } from "./app-root.js";
import { captureConsole } from "./fixtures/capture-console.js";
import { parseReleases, type ReleaseInfo } from "./update/release-check.js";

const release = (tag: string, body = `## Fixed\n\n- **x** — notes for ${tag}`): ReleaseInfo =>
  parseReleases([{ tag_name: tag, name: tag, draft: false, published_at: "2026-10-28T00:00:00Z", body, assets: [] }])[0];

/** git as a checkout on `branch` answers it, with `tags` merged into upstream. */
function fakeGit(tags: string[], branch = "beta", current = "v1.26.0") {
  return async (args: string[]): Promise<string> => {
    const a = args.join(" ");
    if (a === "rev-parse --show-toplevel") return APP_ROOT;
    if (a === "rev-parse --abbrev-ref HEAD") return branch;
    if (a.startsWith("fetch")) return "";
    if (a === "rev-parse --short HEAD") return "abc1234";
    if (a === "show -s --format=%cI HEAD") return "2026-10-01T00:00:00Z";
    if (a.startsWith("tag --list")) return tags.join("\n");
    if (a.startsWith("describe")) return current;
    if (a.startsWith("rev-parse --short")) return "def5678";
    if (a.startsWith("show -s")) return "2026-10-28T00:00:00Z";
    if (a.startsWith("rev-list --count")) return "3";
    if (a.startsWith("log")) return "fix(slots): a change an operator would notice";
    return "";
  };
}

const updaterFor = (tags: string[], fetchReleases: () => Promise<ReleaseInfo[]>, branch = "beta") =>
  new Updater({ git: fakeGit(tags, branch), fetchReleases, version: () => "1.26.0" });

describe("a checkout waits for a tag's release to be published", () => {
  it("takes the newest tag when its release is published", async (t: TestContext) => {
    captureConsole(t, "log", "warn");
    const s = await updaterFor(["v1.27.0", "v1.26.0"], async () => [release("v1.27.0"), release("v1.26.0")]).checkForUpdate();
    assert.equal(s.targetTag, "v1.27.0");
  });

  it("takes the previous published tag while the newest is unpublished, and says so once", async (t: TestContext) => {
    const lines = captureConsole(t, "log", "warn");
    const u = updaterFor(["v1.28.0", "v1.27.0", "v1.26.0"], async () => [release("v1.27.0"), release("v1.26.0")]);
    const first = await u.checkForUpdate();
    await u.checkForUpdate();
    assert.equal(first.targetTag, "v1.27.0", "took a tag whose release does not exist");
    assert.equal(first.releasesBehind, 1, "the held tag counted as an update Update cannot bring");
    const held = lines.filter((l) => /v1\.28\.0 is tagged but its release is not published yet/.test(l));
    assert.equal(held.length, 1, `the hold must be logged once across two checks: ${JSON.stringify(lines)}`);
    assert.match(held[0], /^\[updater\]/);
  });

  it("takes the newest tag, and logs why, when the releases cannot be read", async (t: TestContext) => {
    const lines = captureConsole(t, "log", "warn");
    const u = updaterFor(["v1.28.0", "v1.27.0"], async () => {
      throw new Error("rate limited");
    });
    const s = await u.checkForUpdate();
    await u.checkForUpdate();
    assert.equal(s.error, null);
    assert.equal(s.targetTag, "v1.28.0", "an unreadable API must not stall the box");
    const failed = lines.filter((l) => /could not read the published releases; choosing among all tags/.test(l));
    assert.equal(failed.length, 1, `logged ${failed.length} times: ${JSON.stringify(lines)}`);
    assert.match(failed[0], /rate limited/);
  });

  it("holds nothing when the API lists no release for the track", async (t: TestContext) => {
    captureConsole(t, "log", "warn");
    // main takes stable tags only; the API knows a beta and nothing stable.
    const s = await updaterFor(["v1.27.0", "v1.26.0"], async () => [release("v1.27.0-beta.1")], "main").checkForUpdate();
    assert.equal(s.targetTag, "v1.27.0");
    const none = await updaterFor(["v1.27.0"], async () => []).checkForUpdate();
    assert.equal(none.targetTag, "v1.27.0");
  });

  it("does not hold an unpublished tag older than the newest published one", async (t: TestContext) => {
    const lines = captureConsole(t, "log", "warn");
    // v1.25.0 fell off the API's first page; v1.27.0 is published.
    const s = await updaterFor(["v1.27.0", "v1.25.0"], async () => [release("v1.27.0")]).checkForUpdate();
    assert.equal(s.targetTag, "v1.27.0");
    assert.ok(!lines.some((l) => /v1\.25\.0/.test(l)), "an old tag was reported as waiting");
  });

  it("takes the dialog notes from the published release it chose", async (t: TestContext) => {
    captureConsole(t, "log", "warn");
    const s = await updaterFor(
      ["v1.28.0", "v1.27.0", "v1.26.0"],
      async () => [release("v1.27.0", "## New\n\n- **widgets** — notes for the published one"), release("v1.26.0")],
    ).checkForUpdate();
    const all = (s.changelogSections ?? []).flatMap((sec) => sec.lines).join(" ");
    assert.match(all, /notes for the published one/);
  });

  it("pins the apply to the same tag the check chose", async (t: TestContext) => {
    captureConsole(t, "log", "warn");
    const u = updaterFor(["v1.28.0", "v1.27.0", "v1.26.0"], async () => [release("v1.27.0"), release("v1.26.0")]);
    const checked = await u.checkForUpdate();
    // targetTagFor is what switchTrack and the track switch pin to.
    const pin = await (u as unknown as { targetTagFor(b: string): Promise<string | null> }).targetTagFor("beta");
    assert.equal(pin, checked.targetTag);
    assert.equal(pin, "v1.27.0");
  });
});

describe("merge commits never reach the commit-subject list", () => {
  function realRepo(): { dir: string; git: (args: string[]) => Promise<string> } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "su-merge-"));
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdio: "pipe" })
        .toString()
        .trim();
    run("init", "-q", "-b", "beta");
    run("commit", "-q", "--allow-empty", "-m", "fix(base): the installed state");
    run("tag", "v1.26.0");
    run("checkout", "-q", "-b", "side");
    run("commit", "-q", "--allow-empty", "-m", "fix(side): a real change on a branch");
    run("checkout", "-q", "beta");
    run("commit", "-q", "--allow-empty", "-m", "feat(beta): a real change on beta");
    run("merge", "-q", "--no-ff", "side", "-m", "Merge origin/beta into refactor/shared-inspector-rows");
    // A merge whose subject the changelog's own pattern cannot recognise: only
    // `git log --no-merges` keeps it out.
    run("checkout", "-q", "-b", "side2");
    run("commit", "-q", "--allow-empty", "-m", "fix(side2): another real change");
    run("checkout", "-q", "beta");
    run("merge", "-q", "--no-ff", "side2", "-m", "Bring the second branch across");
    run("tag", "v1.27.0");
    run("update-ref", "refs/remotes/origin/beta", "HEAD");
    run("reset", "-q", "--hard", "v1.26.0");
    return {
      dir,
      git: async (args) => {
        if (args.join(" ") === "rev-parse --show-toplevel") return APP_ROOT;
        if (args[0] === "fetch") return "";
        return run(...args);
      },
    };
  }

  it("a `Merge origin/beta into x` commit is not in the changelog", async (t: TestContext) => {
    captureConsole(t, "log", "warn");
    const { dir, git } = realRepo();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const s = await new Updater({ git, fetchReleases: async () => [release("v1.27.0"), release("v1.26.0")], version: () => "1.26.0" }).checkForUpdate();
    assert.equal(s.targetTag, "v1.27.0");
    const text = (s.changelog ?? []).join("\n");
    assert.match(text, /a real change on beta/, "the fixture lost the real commits");
    assert.match(text, /a real change on a branch/);
    assert.match(text, /another real change/);
    assert.ok(!/Merge|Bring the second/i.test(text), `a merge commit reached the list: ${text}`);
  });
});
