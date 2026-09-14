import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseSections } from "../main/services/update/release-notes.js";

// A release that needs a manual step needs a sentence no commit range can
// produce. Written into docs/release-notes/<version>.md next to the change that
// made it necessary — because a note remembered at release time is a note
// eventually forgotten, and the release it is forgotten on is the one where an
// operator's box silently stops updating.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "release-notes.mjs");
const NOTES_DIR = path.join(HERE, "..", "docs", "release-notes");
const OVERRIDE_DIR = path.join(NOTES_DIR, "overrides");

function notesFor(version: string, from: string, cwd?: string): string {
  return execFileSync("node", [SCRIPT, version, from], { encoding: "utf8", cwd });
}

/** The same, but survivable: an override problem is meant to exit non-zero. */
function runNotes(version: string, from: string, cwd?: string) {
  const r = spawnSync("node", [SCRIPT, version, from], { encoding: "utf8", cwd });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Just one section's text, so a line under another heading cannot satisfy a match. */
function sectionText(out: string, title: string): string {
  const from = out.indexOf(`## ${title}`);
  if (from === -1) return "";
  const rest = out.slice(from + 1);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * A throwaway repository with a history we choose.
 *
 * The alternative — asserting against this repo's own tags — pins the test to
 * whatever happens to be in the log, so it would drift with every release and
 * say nothing precise about the rule. Here the history IS the fixture: two
 * scopes, one that existed before the anchor and one introduced after it.
 */
function buildRepo(): { dir: string; sha: Record<string, string> } {
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
  const sha: Record<string, string> = {};
  const commit = (key: string, subject: string, body?: string) => {
    fs.appendFileSync(path.join(dir, "f"), `${subject}\n`);
    git("add", "-A");
    if (body) git("commit", "-m", subject, "-m", body);
    else git("commit", "-m", subject);
    sha[key] = git("rev-parse", "HEAD").trim();
  };

  git("init", "-q", "-b", "main");

  // BEFORE the anchor: `patch` is an established surface with a released fix.
  commit("patchFeat", "feat(patch): the patch sheet");
  commit("oldFix", "fix(patch): a column that would not save");
  git("tag", "v1.0.0");

  // AFTER: a brand-new `signage` feature and the fixes that built it, plus one
  // more fix to the OLD surface, which a reader has had all along.
  commit("signageFeat", "feat(signage): playlists and a scheduler");
  commit("lostEdit", "fix(signage): a lost edit and a clipped number");
  commit("firstGraphic", "fix(signage): stop sending every wall back to its first graphic");
  commit("rackColour", "fix(patch): the rack colour bled onto the row stripes");
  // The case the scope heuristic is blind to: `patch` is an OLD scope, so a fix
  // under it reads as a fix to something the reader has had all along. This one
  // is not — it repairs a feature added in this very range, and only the author
  // knows that, so the author says so.
  commit("diagramFeat", "feat(patch): a printable diagram");
  commit("legendTwice", "fix(patch): the diagram printed its legend twice", "Beta-only: true");
  // `perf` is its own section. Two, so both halves are covered: one an operator
  // reads, and one held back for never having been in a released version.
  commit("streamPerf", "perf(patch): one stream instead of a six-request poll");
  commit("askOncePerf", "perf(signage): ask once per pair, not every hour", "Beta-only: true");
  // And a breaking change, so every heading the generator can emit is emitted.
  commit("slugBang", "feat(patch)!: a display without a slug now redirects");
  git("tag", "v1.1.0");
  git("tag", "v1.1.0-beta.1");
  // Second names for the same two releases. The override tests write a file
  // into the REAL docs/release-notes/overrides, so the fixture needs a version
  // this repository will never publish — 1.1.0.json could one day be somebody's.
  git("tag", "v9.9.7");
  git("tag", "v9.9.7-beta.1");

  return { dir, sha };
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
  after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  it("a stable release drops them", () => {
    const fixed = sectionText(notesFor("1.1.0", "v1.0.0", repo.dir), "Fixed");
    assert.doesNotMatch(
      fixed,
      /a lost edit and a clipped number/,
      "a fix to a feature introduced in this same release is build-out churn, not news",
    );
    assert.doesNotMatch(fixed, /first graphic/, "the same, for the second one");
  });

  it("but keeps fixes to something the reader already had", () => {
    const fixed = sectionText(notesFor("1.1.0", "v1.0.0", repo.dir), "Fixed");
    assert.match(
      fixed,
      /rack colour bled/,
      "patch shipped before the anchor, so a fix to it is a real fix and must survive",
    );
  });

  it("and says how many it held back, rather than filtering silently", () => {
    // A silent filter reads as "nothing else changed", which is the failure the
    // whole generator exists to avoid.
    assert.match(notesFor("1.1.0", "v1.0.0", repo.dir), /3 further fixes made while building/);
  });

  it("holds back a fix the author marked Beta-only, whatever its scope", () => {
    // THE SCOPE HEURISTIC IS BLIND TO THIS ONE. `patch` shipped before the
    // anchor, so every rule above reads a fix under it as a fix to long-standing
    // behaviour — and this one repairs a feature added in the same range. Only
    // the author knows; the trailer is how they say so.
    const fixed = sectionText(notesFor("1.1.0", "v1.0.0", repo.dir), "Fixed");
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
    assert.match(notesFor("1.1.0", "v1.0.0", repo.dir), /3 further fixes made while building/);
  });

  it("a PRERELEASE keeps everything", () => {
    // Someone on the beta track has been running the broken version. For them
    // the fix is the news, and hiding it would hide the reason to update.
    const fixed = sectionText(notesFor("1.1.0-beta.1", "v1.0.0", repo.dir), "Fixed");
    assert.match(fixed, /a lost edit and a clipped number/);
    assert.match(fixed, /first graphic/);
    // Including one marked Beta-only: the beta reader IS the person who had it.
    assert.match(fixed, /legend twice/);
    assert.doesNotMatch(fixed, /further fixes made while building/);
  });

  it("the new feature itself is still announced", () => {
    // Holding back the fixes must not hold back the thing they were fixing.
    assert.match(notesFor("1.1.0", "v1.0.0", repo.dir), /playlists and a scheduler/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `Beta-only: true` is the author's call, and the author gets it wrong. By the
// time a review catches it the commit is on `beta`, which is never force-pushed,
// so the body cannot be corrected — the notes machinery is the only place left.
//
// Both directions matter. A missing trailer advertises a bug an upgrader never
// had; a wrong one deletes a real fix from the list.
describe("an override for a Beta-only decision that can no longer be made in the commit", () => {
  const repo = buildRepo();
  after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  const VERSION = "9.9.7";
  const file = path.join(OVERRIDE_DIR, `${VERSION}.json`);
  const preFile = path.join(OVERRIDE_DIR, `${VERSION}-beta.1.json`);

  /** Put an override file in place for one run, then take it away again. */
  function withOverride<T>(at: string, body: unknown, run: () => T): T {
    fs.mkdirSync(OVERRIDE_DIR, { recursive: true });
    fs.writeFileSync(at, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    try {
      return run();
    } finally {
      fs.rmSync(at, { force: true });
    }
  }

  it("shows a fix whose Beta-only trailer is wrong", () => {
    // The 1.18.0 case: a fix to behaviour the last stable release really had,
    // marked Beta-only by mistake. The trailer deletes it from the notes and the
    // commit can no longer be edited, so the reader never learns it was fixed.
    const out = withOverride(file, [
      { commit: repo.sha.legendTwice, betaOnly: false, reason: "v1.0.0 shipped the same double legend." },
    ], () => notesFor(VERSION, "v1.0.0", repo.dir));
    assert.match(
      sectionText(out, "Fixed"),
      /legend twice/,
      "a real fix is still being suppressed by a trailer the override says is wrong",
    );
  });

  it("holds back a fix whose trailer is missing", () => {
    // The other 1.18.0 case: the body says outright that the bug never reached a
    // stable tag, and the trailer was never added.
    const out = withOverride(file, [
      { commit: repo.sha.rackColour, betaOnly: true, reason: "Built and broken inside this release." },
    ], () => notesFor(VERSION, "v1.0.0", repo.dir));
    assert.doesNotMatch(
      sectionText(out, "Fixed"),
      /rack colour bled/,
      "a fix nobody could have hit is still being advertised to upgraders",
    );
    // Suppressed is not unmentioned: three from the scope rule plus this one.
    assert.match(out, /4 further fixes made while building/, "the held-back count did not take it in");
  });

  it("beats the scope heuristic, not just the trailer", () => {
    // `signage` is new this range, so the heuristic holds every fix under it
    // back. An override saying otherwise is the author correcting the machine.
    const out = withOverride(file, [
      { commit: repo.sha.lostEdit, betaOnly: false, reason: "The clipped number predates signage." },
    ], () => notesFor(VERSION, "v1.0.0", repo.dir));
    assert.match(sectionText(out, "Fixed"), /a lost edit and a clipped number/);
  });

  it("says on the release log what it changed and why", () => {
    // The reason is the whole point. Left in a file nobody reads it is the same
    // silent decision moved somewhere else, so it goes to the release log.
    const r = withOverride(file, [
      { commit: repo.sha.rackColour, betaOnly: true, reason: "Built and broken inside this release." },
    ], () => runNotes(VERSION, "v1.0.0", repo.dir));
    assert.equal(r.status, 0);
    assert.match(r.stderr, /held back as beta-only, overriding a missing trailer/);
    assert.match(r.stderr, /Built and broken inside this release\./, "the reason never reached the log");
    assert.doesNotMatch(r.stdout, /rack colour bled/, "and the notes must still be corrected");
  });

  it("an override with no reason stops the release", () => {
    const r = withOverride(file, [{ commit: repo.sha.rackColour, betaOnly: true }], () =>
      runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0, "notes were generated from an override that says nothing");
    assert.match(r.stderr, /has no "reason"/);
  });

  it("an empty reason is no reason", () => {
    const r = withOverride(file, [{ commit: repo.sha.rackColour, betaOnly: true, reason: "   " }], () =>
      runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /has no "reason"/);
  });

  it("an override with no direction stops the release", () => {
    const r = withOverride(file, [{ commit: repo.sha.rackColour, reason: "because" }], () =>
      runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs "betaOnly": true or false/);
  });

  it("an override naming a commit this repository does not have stops the release", () => {
    const r = withOverride(file, [
      { commit: "0000000000000000000000000000000000000000", betaOnly: true, reason: "because" },
    ], () => runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not name one commit in this repository/);
  });

  it("an override naming a commit outside the release stops the release", () => {
    // A correction that can never apply is worse than none: it reads as handled.
    const r = withOverride(file, [
      { commit: repo.sha.oldFix, betaOnly: true, reason: "a commit from before the anchor" },
    ], () => runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /which is not a non-breaking fix: or perf: commit in/);
  });

  it("an override naming something that is not a fix stops the release", () => {
    // `betaOnly` only ever holds back a fix or a perf. On a feat it would read
    // as applied and change nothing.
    const r = withOverride(file, [
      { commit: repo.sha.signageFeat, betaOnly: true, reason: "wrong commit pasted" },
    ], () => runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /which is not a non-breaking fix: or perf: commit in/);
  });

  it("a file that will not parse stops the release rather than quietly generating notes", () => {
    const r = withOverride(file, "{ not json", () => runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0, "a broken override file generated notes as though it were absent");
    assert.match(r.stderr, /is not valid JSON/);
  });

  it("a file that is not a list stops the release", () => {
    const r = withOverride(file, { commit: repo.sha.rackColour }, () => runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must be a JSON array of overrides/);
  });

  it("the same commit overridden twice stops the release", () => {
    const r = withOverride(file, [
      { commit: repo.sha.rackColour, betaOnly: true, reason: "one" },
      { commit: repo.sha.rackColour, betaOnly: false, reason: "and the opposite" },
    ], () => runNotes(VERSION, "v1.0.0", repo.dir));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is overridden twice/);
  });

  it("a PRERELEASE keeps everything, overrides included", () => {
    // Someone on the beta track HAS been running the broken version, so nothing
    // is held back from them — and an override that held one back would hide the
    // very fix they are being asked to test.
    const out = withOverride(preFile, [
      { commit: repo.sha.rackColour, betaOnly: true, reason: "Built and broken inside this release." },
    ], () => notesFor(`${VERSION}-beta.1`, "v1.0.0", repo.dir));
    assert.match(sectionText(out, "Fixed"), /rack colour bled/);
  });

  it("no file at all is the ordinary case and generates notes as before", () => {
    assert.equal(fs.existsSync(file), false, "the fixture leaked an override file");
    const r = runNotes(VERSION, "v1.0.0", repo.dir);
    assert.equal(r.status, 0);
    assert.match(sectionText(r.stdout, "Fixed"), /rack colour bled/);
  });
});

// The corrections this repository actually ships. Each is a claim about a commit
// on `beta`, so each is checked against that commit rather than taken on trust.
describe("the overrides in docs/release-notes/overrides", () => {
  const REPO_ROOT = path.join(HERE, "..");

  /** Every release with an override, EXACTLY. Adding one is a deliberate act and
   *  should have to be declared here; a file quietly disappearing is the bug. */
  const VERSIONS_WITH_OVERRIDES = ["1.18.0"];

  interface Override { commit: string; betaOnly: boolean; reason: string }

  function subjectOf(sha: string): string {
    return execFileSync("git", ["log", "-1", "--format=%s", sha], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    }).trim();
  }

  it("are exactly the releases that declare one", () => {
    const found = fs.readdirSync(OVERRIDE_DIR).filter((f) => f.endsWith(".json")).sort();
    assert.deepEqual(found, VERSIONS_WITH_OVERRIDES.map((v) => `${v}.json`));
  });

  it("each name a commit this repository carries, and say why", () => {
    for (const v of VERSIONS_WITH_OVERRIDES) {
      const list = JSON.parse(fs.readFileSync(path.join(OVERRIDE_DIR, `${v}.json`), "utf8")) as Override[];
      assert.ok(list.length, `${v}.json is empty`);
      for (const e of list) {
        assert.equal(typeof e.betaOnly, "boolean", `${v}.json: ${e.commit} has no direction`);
        assert.ok(e.reason?.trim(), `${v}.json: ${e.commit} has no reason`);
        // Reachable from HEAD, not merely a valid-looking hex string.
        assert.doesNotThrow(
          () => execFileSync("git", ["merge-base", "--is-ancestor", e.commit, "HEAD"], { cwd: REPO_ROOT }),
          `${v}.json: ${e.commit} is not an ancestor of HEAD`,
        );
      }
    }
  });

  it("1.18.0 corrects both trailers the release review found", () => {
    // Frozen on purpose: a shipped release's overrides stop changing. Matched by
    // the SUBJECT git reports for the SHA, so a wrong SHA cannot satisfy it.
    const list = JSON.parse(fs.readFileSync(path.join(OVERRIDE_DIR, "1.18.0.json"), "utf8")) as Override[];
    assert.equal(list.length, 2);
    const bySubject = new Map(list.map((e) => [subjectOf(e.commit), e]));

    const safespace = bySubject.get("fix: SafeSpace edges a pre-PR review found by driving them");
    assert.ok(safespace, "the SafeSpace commit is no longer overridden — it returns to the Fixed list");
    assert.equal(safespace.betaOnly, true, "it must be held back: its own body says it never reached a stable tag");

    const simulated = bySubject.get("fix(cues): the verdict line says when a dispatch was simulated");
    assert.ok(simulated, "the simulated-dispatch commit is no longer overridden — its wrong trailer wins again");
    assert.equal(simulated.betaOnly, false, "v1.17.1 logged a bare 'dispatched' in simulate mode, which is the default");
  });
});

// `perf` reached the operator as a bug fix. "anchor the record clock instead of
// polling a timecode" and "drop include=items from the once-per-second PCO live
// read" are both work that made the app quicker, and both went out under Fixed —
// read as a report of something that had been broken on their install.
//
// The dialog has rendered an Improved heading since it learned about sections
// (SECTION_ORDER, and a tone for it in update-notices.tsx). Nothing was ever
// routed there.
describe("perf is an improvement, not a bug fix", () => {
  const repo = buildRepo();
  after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  it("a perf commit lands under Improved", () => {
    const out = notesFor("1.1.0", "v1.0.0", repo.dir);
    assert.match(sectionText(out, "Improved"), /one stream instead of a six-request poll/);
    assert.doesNotMatch(
      sectionText(out, "Fixed"),
      /six-request poll/,
      "a perf commit still reaches the operator as a bug they had",
    );
  });

  it("a held-back perf is counted as an improvement, not as a fix", () => {
    // Each section's arithmetic is its own, or the Fixed note claims a count
    // that includes work no reasonable person would call a fix.
    const out = notesFor("1.1.0", "v1.0.0", repo.dir);
    assert.match(sectionText(out, "Improved"), /1 further improvement made while building/);
    assert.match(sectionText(out, "Fixed"), /3 further fixes made while building/);
  });

  it("every heading the generator emits is one the update dialog renders", () => {
    // The whole class of bug, checked by running both real pieces against each
    // other rather than by reading either. A section the generator invents, or
    // renames, disappears from the dialog without a word — which is exactly how
    // four perf commits went out mislabelled and nobody could see it.
    const out = notesFor("1.1.0", "v1.0.0", repo.dir);
    const emitted = [...out.matchAll(/^## (.+)$/gm)].map((m) => m[1]).filter((h) => h !== "Install");
    assert.deepEqual(emitted, ["Breaking", "New", "Improved", "Fixed"]);

    const rendered = parseReleaseSections(out, 100).map((s) => s.section);
    assert.deepEqual(rendered, emitted, "the dialog drops a heading the notes generator emits");
  });
});
