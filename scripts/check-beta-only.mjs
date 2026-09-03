// Flags a fix/perf commit that LOOKS like it belongs to a feature built this
// cycle, so the author is reminded to add the `Beta-only: true` trailer
// documented in docs/contributing.md.
//
// The heuristic: for every non-merge `fix:`/`perf:` commit in `<base>..HEAD`
// without the trailer already, look at the files it touches. If at least one
// of them was ALSO touched by a `feat:` commit since the last stable tag
// (highest `vX.Y.Z` with no `-`) — not just since `<base>`, because the
// feature may have landed in an earlier PR this cycle — the fix is flagged as
// probably belonging to that feature.
//
// What it CANNOT see: a fix to old code that happens to touch a file a
// feature also edited is a false positive — sharing a file does not mean
// sharing a bug. And a fix to a genuinely new feature, in a file no `feat:`
// commit happened to touch, is missed entirely. Only the author knows whether
// the bug ever reached a released version — see docs/contributing.md,
// "Beta-only: true".
//
// This is a heuristic and a warning, not a gate: it ALWAYS exits 0. Flagged
// commits are still printed loudly, and get a GitHub Actions `::warning::`
// annotation when running in Actions, so they are hard to miss without ever
// failing the job.
//
//   node scripts/check-beta-only.mjs <base-ref>

import { execFileSync } from "node:child_process";

const TRAILER_PATTERN = /^Beta-only:\s*(true|yes)\s*$/im;
const FIX_PERF_SUBJECT = /^(fix|perf)(\([^)]+\))?!?:/;
const FEAT_SUBJECT = /^feat(\([^)]+\))?!?:/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function lastStableTag() {
  let out;
  try {
    out = git(["tag", "-l", "v*", "--sort=-v:refname"]);
  } catch {
    return null;
  }
  const tags = out.split("\n").filter(Boolean);
  return tags.find((t) => !t.includes("-")) ?? null;
}

function commitFiles(sha) {
  return git(["show", "--name-only", "--format=", sha])
    .split("\n")
    .filter(Boolean);
}

/**
 * feat: commits since the stable tag, each with the files they touched, so a
 * fix's files can be checked against them for overlap.
 */
function featCommitsSince(stableTag) {
  const shas = git(["log", "--no-merges", "--format=%H", `${stableTag}..HEAD`])
    .split("\n")
    .filter(Boolean);

  const feats = [];
  for (const sha of shas) {
    const subject = git(["log", "-1", "--format=%s", sha]).trim();
    if (!FEAT_SUBJECT.test(subject)) continue;
    feats.push({ sha, subject, files: commitFiles(sha) });
  }
  return feats;
}

export function findBetaOnlyCandidates(base, stableTag) {
  const feats = featCommitsSince(stableTag);

  const shas = git(["log", "--no-merges", "--format=%H", `${base}..HEAD`])
    .split("\n")
    .filter(Boolean);

  const flagged = [];
  for (const sha of shas) {
    const subject = git(["log", "-1", "--format=%s", sha]).trim();
    if (!FIX_PERF_SUBJECT.test(subject)) continue;

    const body = git(["log", "-1", "--format=%b", sha]);
    if (TRAILER_PATTERN.test(body)) continue;

    const files = commitFiles(sha);
    if (files.length === 0) continue;

    const sharedWith = [];
    for (const feat of feats) {
      const sharedFile = files.find((f) => feat.files.includes(f));
      if (sharedFile) {
        sharedWith.push({ sha: feat.sha.slice(0, 7), subject: feat.subject, file: sharedFile });
      }
    }

    if (sharedWith.length > 0) {
      flagged.push({ sha: sha.slice(0, 7), subject, sharedWith });
    }
  }
  return flagged;
}

function main() {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: node scripts/check-beta-only.mjs <base-ref>");
    process.exitCode = 0;
    return;
  }

  const stableTag = lastStableTag();
  if (!stableTag) {
    console.log("No stable tag (vX.Y.Z with no pre-release suffix) found — nothing to compare against.");
    return;
  }

  const flagged = findBetaOnlyCandidates(base, stableTag);

  if (flagged.length === 0) {
    console.log(`Checked every fix/perf commit against ${stableTag} — none looked beta-only.`);
    return;
  }

  for (const { sha, subject, sharedWith } of flagged) {
    const line = `${sha} ${subject}`;
    console.log(line);
    for (const { sha: featSha, subject: featSubject, file } of sharedWith) {
      const hint = `shares ${file} with feat ${featSha} "${featSubject}"; if the bug is in that feature, add the trailer "Beta-only: true"`;
      console.log(`  ${hint}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning::${line} — ${hint}`);
      }
    }
  }
}

// Only when run directly, so findBetaOnlyCandidates can be imported by a test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
