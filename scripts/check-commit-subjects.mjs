// The conventional-commit rule, in ONE place.
//
// CI enforced it and nothing ran it locally, so the first time a subject was
// wrong was after a push — three times in one week, twice for the same reason: a
// scope with a comma and a space in it, which the pattern below does not admit
// because scopes are `[a-z0-9.+/-]`.
//
// The workflow calls this rather than carrying its own copy of the pattern. Two
// copies of a rule is how the copies drift, and a lint rule that disagrees with
// the CI enforcing it is worse than no lint rule.
//
//   node scripts/check-commit-subjects.mjs [base]
//
// `base` defaults to origin/beta, which is what a branch here is normally cut
// from. Exits non-zero and names every subject that does not conform.

import { execFileSync } from "node:child_process";
import { isMain } from "./is-main.mjs";
import COMMIT_TYPE_FILE from "../main/services/commit-types.json" with { type: "json" };

/**
 * The types that may carry a `!`: all but revert. A revert releases nothing, so a
 * breaking one would head the notes' Breaking list while the release level
 * ignored it.
 */
const BREAKABLE = [...COMMIT_TYPE_FILE.minor, ...COMMIT_TYPE_FILE.patch, ...COMMIT_TYPE_FILE.invisible];
const ALL_TYPES = [...BREAKABLE, ...COMMIT_TYPE_FILE.revert];

const SCOPE = "(?:\\([a-z0-9.+/-]+\\))?";

/** type(scope)!: subject — scope is lower-case and takes no spaces or commas. */
export const SUBJECT_PATTERN = new RegExp(
  `^(?:(?:${BREAKABLE.join("|")})${SCOPE}!?|(?:${COMMIT_TYPE_FILE.revert.join("|")})${SCOPE}): .+`,
);

/**
 * `git revert` writes `Revert "<original subject>"`.
 *
 * Accepted as-is deliberately: the only way to fix such a commit once pushed is
 * to rewrite the branch, and beta and main are never force-pushed. The generated
 * form is unambiguous.
 */
export const REVERT_PATTERN = /^Revert ".+"/;

export function subjectIsValid(subject) {
  return SUBJECT_PATTERN.test(subject) || REVERT_PATTERN.test(subject);
}

function main() {
  const base = process.argv[2] ?? "origin/beta";
  let subjects;
  try {
    // --no-merges: GitHub authors merge commits and they carry no release meaning.
    const out = execFileSync("git", ["log", "--no-merges", "--format=%s", `${base}..HEAD`], {
      encoding: "utf8",
    });
    subjects = out.split("\n").filter(Boolean);
  } catch {
    console.error(`Could not read commits for ${base}..HEAD — is ${base} fetched?`);
    process.exitCode = 1;
    return;
  }

  if (subjects.length === 0) {
    console.log("No non-merge commits to check.");
    return;
  }

  let bad = 0;
  for (const s of subjects) {
    if (subjectIsValid(s)) {
      console.log(`  ok   ${s}`);
    } else {
      console.log(`  BAD  ${s}`);
      bad++;
    }
  }

  if (bad > 0) {
    console.error(`
One or more commit subjects do not follow the convention.

  type(scope): subject

type must be one of:
  ${ALL_TYPES.join(" ")}

scope is optional, lower-case, and takes NO spaces or commas —
"fix(editor, resi):" is the shape that keeps failing; use one scope,
or none at all.

Add "!" after the type/scope for a breaking change (any type but
revert). Subject is imperative mood, no trailing period.

See docs/contributing.md. Reword with:
  git rebase -i ${base}`);
    process.exitCode = 1;
  }
}

// Only when run directly, so the patterns can be imported by a test.
if (isMain(import.meta.url, process.argv[1])) main();
