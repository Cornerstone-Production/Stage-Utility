// Turns raw commit subjects into the "What's new" list the updater shows.
//
// The pending commits are not a changelog. Most of what lands between two
// deployments is invisible to an operator — CI tweaks, refactors, test changes —
// and the release workflow adds one of its own on every release:
//
//   chore(release): v1.4.3-beta.1 [skip ci]
//
// which is how a box could offer an update whose only listed change was the
// version number being written down. Merge commits are the same kind of noise.
//
// The filter follows the repo's own commit convention (docs/contributing.md): the
// types that produce a release are the types a user can tell apart. Anything that
// does not parse as a conventional commit is KEPT rather than dropped — an
// unrecognised subject is more likely to be a real change than something to hide.

/** Commit types that change nothing an operator could notice. */
const INVISIBLE = new Set(["chore", "ci", "build", "docs", "test", "refactor", "style"]);

/** `type(optional-scope)!: subject` */
const CONVENTIONAL = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/i;

const MERGE = /^Merge (pull request|branch|remote-tracking)\b/i;

/** Trailing CI directives — noise in a list meant for a person. */
const CI_DIRECTIVE = /\s*\[(skip ci|ci skip|no ci)\]\s*$/i;

/**
 * The user-facing subset of `subjects`, in the order given, deduplicated and
 * capped.
 *
 * Returning an empty list is a meaningful answer: the update carries nothing an
 * operator would notice, and the caller hides the panel rather than showing a
 * heading over nothing.
 */
export function summarizeChangelog(subjects: readonly string[], cap = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of subjects) {
    const subject = raw.replace(CI_DIRECTIVE, "").trim();
    if (!subject || MERGE.test(subject)) continue;
    const m = CONVENTIONAL.exec(subject);
    if (m && INVISIBLE.has(m[1].toLowerCase())) continue;
    if (seen.has(subject)) continue;
    seen.add(subject);
    out.push(subject);
    if (out.length >= cap) break;
  }
  return out;
}
