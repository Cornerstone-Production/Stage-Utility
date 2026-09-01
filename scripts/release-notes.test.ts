import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// A release that needs a manual step needs a sentence no commit range can
// produce. Written into docs/release-notes/<version>.md next to the change that
// made it necessary — because a note remembered at release time is a note
// eventually forgotten, and the release it is forgotten on is the one where an
// operator's box silently stops updating.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "release-notes.mjs");
const NOTES_DIR = path.join(HERE, "..", "docs", "release-notes");

function notesFor(version: string, from: string, cwd?: string): string {
  return execFileSync("node", [SCRIPT, version, from], { encoding: "utf8", cwd });
}

/**
 * A throwaway repository with a history we choose.
 *
 * The alternative — asserting against this repo's own tags — pins the test to
 * whatever happens to be in the log, so it would drift with every release and
 * say nothing precise about the rule. Here the history IS the fixture: two
 * scopes, one that existed before the anchor and one introduced after it.
 */
function buildRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  const commit = (subject: string, body?: string) => {
    fs.appendFileSync(path.join(dir, "f"), `${subject}\n`);
    git("add", "-A");
    if (body) git("commit", "-m", subject, "-m", body);
    else git("commit", "-m", subject);
  };

  git("init", "-q", "-b", "main");

  // BEFORE the anchor: `patch` is an established surface with a released fix.
  commit("feat(patch): the patch sheet");
  commit("fix(patch): a column that would not save");
  git("tag", "v1.0.0");

  // AFTER: a brand-new `signage` feature and the fixes that built it, plus one
  // more fix to the OLD surface, which a reader has had all along.
  commit("feat(signage): playlists and a scheduler");
  commit("fix(signage): a lost edit and a clipped number");
  commit("fix(signage): stop sending every wall back to its first graphic");
  commit("fix(patch): the rack colour bled onto the row stripes");
  // The case the scope heuristic is blind to: `patch` is an OLD scope, so a fix
  // under it reads as a fix to something the reader has had all along. This one
  // is not — it repairs a feature added in this very range, and only the author
  // knows that, so the author says so.
  commit("feat(patch): a printable diagram");
  commit("fix(patch): the diagram printed its legend twice", "Beta-only: true");
  git("tag", "v1.1.0");
  git("tag", "v1.1.0-beta.1");

  return dir;
}

describe("release notes", () => {
  it("prepends the notice for a version that has one, above everything generated", () => {
    const version = "9.9.9-notice-test";
    const file = path.join(NOTES_DIR, `${version}.md`);
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(file, "> **Read this first.** One manual step.\n");
    try {
      const out = notesFor(version, "v1.9.4");
      assert.match(out, /Read this first/, "the notice must appear");
      // Above the generated sections, or a reader scrolling past bullets misses it.
      assert.ok(out.indexOf("Read this first") < out.indexOf("## Install"), "notice must come first");
      // And separated from them. The notice is trimmed on read, so without a
      // restored trailing newline the next heading butts onto its last line —
      // every other section is joined with a blank line between.
      assert.doesNotMatch(out, /\S\n## /, "a generated heading must not follow prose without a blank line");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("says nothing extra for an ordinary release", () => {
    const out = notesFor("9.9.8-no-notice", "v1.9.4");
    assert.doesNotMatch(out, /Read this first/);
    assert.match(out, /## Install/, "the ordinary sections still render");
  });

  it("ships a notice for 1.10.0, the release that needs one", () => {
    // Packaged installs on 1.9.x cannot self-update to it — in-app updates for
    // them are new IN 1.10.0 — so it must say so, with the command.
    const file = path.join(NOTES_DIR, "1.10.0.md");
    assert.ok(fs.existsSync(file), "docs/release-notes/1.10.0.md must exist");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /install\.sh/, "must give the Linux/macOS command");
    assert.match(text, /install\.ps1/, "must give the Windows command");
    assert.match(text, /brew upgrade/, "must give the Homebrew command");
    assert.match(text, /checkout/i, "must say a git checkout needs none of it");
  });
});

// A stable release folds in thirty-odd betas. "Fixed" filled up with the polish
// commits that BUILT the release's own new features — a reader who has never had
// digital signage does not need eleven lines about signage bugs, and those lines
// crowded out fixes to the things they do have.
//
// The rule is deliberately narrow: a fix is held back only when its scope both
// shipped a feature in this range AND never appeared before the anchor. A
// release carrying `feat(ui)` for a new colour picker also carried `fix(ui)` for
// tinted icons that scrolled wrong — a real fix to long-standing behaviour, and
// the second condition is what keeps it in the list.
describe("fixes made while building a brand-new feature", () => {
  const repo = buildRepo();
  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  /** Just the Fixed section, so a scope named under New cannot satisfy a match. */
  function fixedSection(out: string): string {
    const from = out.indexOf("## Fixed");
    if (from === -1) return "";
    const rest = out.slice(from + 1);
    const next = rest.indexOf("\n## ");
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("a stable release drops them", () => {
    const fixed = fixedSection(notesFor("1.1.0", "v1.0.0", repo));
    assert.doesNotMatch(
      fixed,
      /a lost edit and a clipped number/,
      "a fix to a feature introduced in this same release is build-out churn, not news",
    );
    assert.doesNotMatch(fixed, /first graphic/, "the same, for the second one");
  });

  it("but keeps fixes to something the reader already had", () => {
    const fixed = fixedSection(notesFor("1.1.0", "v1.0.0", repo));
    assert.match(
      fixed,
      /rack colour bled/,
      "patch shipped before the anchor, so a fix to it is a real fix and must survive",
    );
  });

  it("and says how many it held back, rather than filtering silently", () => {
    // A silent filter reads as "nothing else changed", which is the failure the
    // whole generator exists to avoid.
    assert.match(notesFor("1.1.0", "v1.0.0", repo), /3 further fixes made while building/);
  });

  it("holds back a fix the author marked Beta-only, whatever its scope", () => {
    // THE SCOPE HEURISTIC IS BLIND TO THIS ONE. `patch` shipped before the
    // anchor, so every rule above reads a fix under it as a fix to long-standing
    // behaviour — and this one repairs a feature added in the same range. Only
    // the author knows; the trailer is how they say so.
    const fixed = fixedSection(notesFor("1.1.0", "v1.0.0", repo));
    assert.doesNotMatch(
      fixed,
      /legend twice/,
      "a fix the author marked Beta-only reached a stable release's notes — the reader never had that bug",
    );
    // And the rule did not become "suppress everything under an old scope".
    assert.match(
      fixed,
      /rack colour bled/,
      "an unmarked fix to the same old scope was suppressed with it",
    );
  });

  it("a Beta-only fix still counts toward the held-back total", () => {
    // Suppressed is not the same as unmentioned. A silent filter is the failure
    // the whole generator exists to avoid, and that is as true of a fix the
    // author held back as of one the scope rule held back.
    assert.match(notesFor("1.1.0", "v1.0.0", repo), /3 further fixes made while building/);
  });

  it("a PRERELEASE keeps everything", () => {
    // Someone on the beta track has been running the broken version. For them
    // the fix is the news, and hiding it would hide the reason to update.
    const fixed = fixedSection(notesFor("1.1.0-beta.1", "v1.0.0", repo));
    assert.match(fixed, /a lost edit and a clipped number/);
    assert.match(fixed, /first graphic/);
    // Including one marked Beta-only: the beta reader IS the person who had it.
    assert.match(fixed, /legend twice/);
    assert.doesNotMatch(fixed, /further fixes made while building/);
  });

  it("the new feature itself is still announced", () => {
    // Holding back the fixes must not hold back the thing they were fixing.
    assert.match(notesFor("1.1.0", "v1.0.0", repo), /playlists and a scheduler/);
  });
});
