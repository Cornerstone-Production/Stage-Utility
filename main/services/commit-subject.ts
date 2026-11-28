// The one reader of a commit subject (and of the Beta-only trailer in its body), for the update dialog's "What's new"
// (main/services/changelog.ts) and the release notes (scripts/release-notes.ts).
//
// Two parsers of `type(scope)!: text` had drifted: the notes kept `refactor!:`
// as a breaking change and the dialog dropped it. What counts as invisible, and
// what a `!` does about it, is decided here and nowhere else.
//
// Pure, and imports only JSON, because scripts/ runs it under bare node
// (`node scripts/release-notes.ts`), where a `.js` import of a `.ts` file does
// not resolve.

import COMMIT_TYPE_FILE from "./commit-types.json" with { type: "json" };
import INTERNAL_SCOPE_FILE from "./internal-scopes.json" with { type: "json" };

/**
 * Commit types that change nothing an operator could notice, and the legacy ones
 * the lint refuses but old history may still carry.
 */
export const INVISIBLE_TYPES: ReadonlySet<string> = new Set([...COMMIT_TYPE_FILE.invisible, ...COMMIT_TYPE_FILE.legacy]);

/**
 * Scopes that name the release machinery itself. A `fix(release)` is honestly a
 * fix, and an operator cannot see it. Also read by scripts/release-level.sh.
 */
export const INTERNAL_SCOPES: ReadonlySet<string> = new Set(INTERNAL_SCOPE_FILE.scopes);

/**
 * `Beta-only: true` in a commit body — this fixed a bug that never reached a stable release.
 * Matched against the BODY, not the subject, and shared with scripts/check-beta-only.ts.
 *
 * The scope heuristic in the notes cannot see these. It asks whether a fix's SCOPE is new this
 * release, which catches a whole new subsystem and misses a new feature built under an existing
 * one: `fix(integrations): the Setup guide links to this build's branch` repairs something added
 * in the same release, but `integrations` is years old, so it reads as a fix to long-standing
 * behaviour. In 1.13.0 there were 13 such scopes carrying 42 fixes. Only the author knows, so
 * only the author can say. Prereleases keep them either way: someone on the beta track HAS been
 * running the broken version.
 */
export const BETA_ONLY_TRAILER = /^Beta-only:\s*(true|yes)\s*$/im;

/** `type(optional-scope)!: text` */
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i;

export interface ParsedSubject {
  /** Lower-cased. */
  type: string;
  /** As written, or undefined when the subject has none. */
  scope: string | undefined;
  /** The scope lower-cased, for lookups; null when there is none. */
  scopeKey: string | null;
  /** A `!` before the colon, whatever the type. */
  breaking: boolean;
  text: string;
}

/** The parts of a conventional-commit subject, or null for one that is not. */
export function parseSubject(subject: string): ParsedSubject | null {
  const m = CONVENTIONAL.exec(subject);
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    scope: m[2] || undefined,
    scopeKey: m[2] ? m[2].toLowerCase() : null,
    breaking: m[3] === "!",
    text: m[4],
  };
}

/**
 * Whether a parsed subject belongs in an operator-facing list. A breaking change
 * is shown whatever its type or scope: the `!` is the only mark it gets.
 */
export function isShownInNotes(p: ParsedSubject): boolean {
  if (p.breaking) return true;
  if (INVISIBLE_TYPES.has(p.type)) return false;
  return !(p.scopeKey !== null && INTERNAL_SCOPES.has(p.scopeKey));
}
