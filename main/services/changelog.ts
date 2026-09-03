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

/** The same, with the scope captured so it can lead the line. */
const SCOPED = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/i;

/** `type!:` or `type(scope)!:` — a breaking change, whatever its type. */
const BREAKING = /^[a-z]+(?:\([^)]*\))?!:/i;

/** Types whose name tells an operator nothing the dialog has not already said. */
const DROPPABLE = new Set(["feat", "fix", "perf"]);

const MERGE = /^Merge (pull request|branch|remote-tracking)\b/i;

/** Trailing CI directives — noise in a list meant for a person. */
const CI_DIRECTIVE = /\s*\[(skip ci|ci skip|no ci)\]\s*$/i;

import SCOPE_LABEL_FILE from "./scope-labels.json" with { type: "json" };

/** Jargon scopes and what to call them. Shared with scripts/release-notes.mjs. */
const SCOPE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(SCOPE_LABEL_FILE).filter(([k]) => !k.startsWith("_")),
) as Record<string, string>;

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
    out.push(presentable(subject));
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * `fix(a11y): the console's icon set opens from the keyboard`
 *   -> `accessibility — the console's icon set opens from the keyboard`
 *
 * The TYPE goes: an operator reading "what changed" does not need to be told
 * which of `fix` and `feat` the author chose, and the dialog is already titled
 * "Updated to". The SCOPE stays, because it says which part of the app moved,
 * and it is rendered the way the published release notes render it — this list
 * only appears on a git checkout, which has no release body to parse, and the
 * same update showing `fix(scores):` on one install and `scores — …` on another
 * is the same release described two ways.
 *
 * A scope nobody outside the repo would recognise is spelled out; see
 * scope-labels.json, which the notes generator reads too.
 */
function presentable(subject: string): string {
  const m = SCOPED.exec(subject);
  if (!m) return subject;
  const [, type, scope, text] = m;

  // TWO TYPES CARRY MEANING AND MUST SURVIVE WHOLE.
  //
  // `revert: "feat: add thing"` shortened to `"feat: add thing"` says the
  // OPPOSITE of what happened — the line would announce a feature the update
  // removes. And a `!` is the only mark a breaking change gets; dropping it
  // leaves the one line an operator must not skim past looking like every other.
  //
  // Both were caught by tests that already existed, which is the reason to run
  // them before believing a formatting change is only formatting.
  if (BREAKING.test(subject) || !DROPPABLE.has(type.toLowerCase())) return subject;

  if (!scope) return text;
  const key = scope.toLowerCase();
  return `${SCOPE_LABELS[key] ?? scope} — ${text}`;
}
