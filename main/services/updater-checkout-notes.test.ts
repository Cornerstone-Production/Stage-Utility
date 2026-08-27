// A git checkout got a different update dialog than a packaged install.
//
// 1.12.0 landed on a checkout as eight bare `fix(scope): subject` lines under no
// headings at all, where the same release on a packaged box showed Breaking /
// New / Fixed. The grouping only exists in the release notes: a checkout has
// history, so it built its changelog from commit subjects and never read them,
// and `captureJustUpdated` stored `notes: []` — which is precisely the case the
// notice store's flat `lines` fallback covers, so the dialog rendered subjects
// and nobody noticed the sections were missing rather than empty.
//
// This is the same parity gap release-check.ts already closed in the other
// direction for the update PANEL, where a packaged install listed bare tags
// while its git sibling listed real subjects.
//
// The seams replace only what a test cannot have: a real checkout's git, and
// the releases API. Everything between them is the real checkForUpdate path.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Updater } from "./updater.js";
import { APP_ROOT } from "./app-root.js";
import { parseReleases, type ReleaseInfo } from "./update/release-check.js";

/** A release whose body is shaped the way this repo's actually are. */
const BODY = [
  "## New",
  "",
  "- **resi** — widen the probe to every row, and follow a scheduleId",
  "",
  "## Fixed",
  "",
  "- **slots** — stop cropping a face off before the browser sees it",
  "- **editor** — the canvas row keeps its height when the slots editor opens below it",
  "",
  "## Install",
  "",
  "Not part of what changed.",
].join("\n");

const RELEASES: ReleaseInfo[] = parseReleases([
  { tag_name: "v1.12.0", name: "v1.12.0", draft: false, published_at: "2026-08-27T00:00:00Z", body: BODY, assets: [] },
  { tag_name: "v1.11.0", name: "v1.11.0", draft: false, published_at: "2026-08-26T00:00:00Z", body: "## Fixed\n\n- **old** — nothing to do with this", assets: [] },
]);

/** git as a real checkout answers it: on main, one release behind. */
async function checkoutGit(args: string[]): Promise<string> {
  const a = args.join(" ");
  if (a === "rev-parse --show-toplevel") return APP_ROOT;
  if (a === "rev-parse --abbrev-ref HEAD") return "main";
  if (a.startsWith("fetch")) return "";
  if (a === "rev-parse --short HEAD") return "abc1234";
  if (a === "show -s --format=%cI HEAD") return "2026-08-26T00:00:00Z";
  if (a.startsWith("tag --list")) return "v1.12.0\nv1.11.0";
  if (a.startsWith("describe")) return "v1.11.0";
  if (a.startsWith("rev-parse --short")) return "def5678";
  if (a.startsWith("show -s")) return "2026-08-27T00:00:00Z";
  if (a.startsWith("rev-list --count")) return "2";
  // The flat changelog a checkout has always built for itself.
  if (a.startsWith("log --format=%s")) {
    return "fix(slots): stop cropping a face off before the browser sees it\nfix(editor): the canvas row keeps its height";
  }
  return "";
}

const checkoutUpdater = (fetchReleases: () => Promise<ReleaseInfo[]> = async () => RELEASES) =>
  new Updater({ git: checkoutGit, fetchReleases, version: () => "1.11.0" });

describe("the update dialog on a git checkout", () => {
  it("is a real checkout, one release behind — the fixture, not the fix", async () => {
    const s = await checkoutUpdater().checkForUpdate();
    assert.equal(s.isGitRepo, true);
    assert.equal(s.tagBased, true);
    assert.equal(s.targetTag, "v1.12.0");
    assert.ok((s.behindUserFacing ?? 0) > 0, "nothing pending means nothing to group");
  });

  it("gets the SECTIONS, not just commit subjects", async () => {
    const s = await checkoutUpdater().checkForUpdate();
    assert.ok(s.changelogSections && s.changelogSections.length > 0, "no sections: the dialog falls back to bare subjects");
    assert.deepEqual(
      s.changelogSections.map((sec) => sec.section),
      ["New", "Fixed"],
      "grouped, and in the order the dialog renders",
    );
  });

  it("carries the notes' own wording, not the commit log's", () => {
    // The two differ on purpose: notes say "**slots** — ...", commits say
    // "fix(slots): ...". Asserting the notes' shape is what proves the sections
    // came from the release rather than from `git log`.
    return checkoutUpdater()
      .checkForUpdate()
      .then((s) => {
        const fixed = s.changelogSections?.find((sec) => sec.section === "Fixed");
        assert.ok(fixed, "no Fixed section");
        assert.ok(
          fixed.lines.some((l) => /stop cropping a face off/.test(l)),
          `Fixed did not carry the release's own lines: ${JSON.stringify(fixed.lines)}`,
        );
        assert.ok(
          !fixed.lines.some((l) => /^fix\(/.test(l)),
          "these are commit subjects, so the notes were never read",
        );
      });
  });

  it("takes only what is newer than the installed tag", async () => {
    const s = await checkoutUpdater().checkForUpdate();
    const all = (s.changelogSections ?? []).flatMap((sec) => sec.lines).join(" ");
    assert.ok(!/nothing to do with this/.test(all), "pulled in a release this box already has");
  });

  it("drops the notes' non-change headings", async () => {
    const s = await checkoutUpdater().checkForUpdate();
    assert.ok(
      !(s.changelogSections ?? []).some((sec) => /install/i.test(sec.section)),
      "the Install instructions are not a change",
    );
  });

  it("keeps the flat list when the notes cannot be read, rather than failing the check", async () => {
    // A dialog with no grouping beats a box that cannot tell it has an update.
    const s = await checkoutUpdater(async () => {
      throw new Error("rate limited");
    }).checkForUpdate();
    assert.equal(s.error, null, "a missing changelog is not a failed update check");
    assert.equal(s.targetTag, "v1.12.0", "still knows what it would install");
    assert.deepEqual(s.changelogSections, [], "no sections rather than stale ones");
    assert.ok((s.changelog ?? []).length > 0, "the commit-subject fallback still stands");
  });
});
