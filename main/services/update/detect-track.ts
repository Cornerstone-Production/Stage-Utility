// detect-track.ts — which update track a packaged install is actually following.
//
// A git checkout knows its track: it is the checked-out branch. A packaged
// install has no branch, and the answer used to default to "main" — which is how
// a Homebrew box running beta reported itself as main.
//
// Every answer here is derived from something real on disk. There is deliberately
// no fallback to "main": a confidently wrong track is exactly the bug this
// replaces, and "unknown" is the honest answer when nothing says otherwise.

import type { InstallKind } from "./install-kind.js";
import { FORMULA } from "./homebrew-strategy.js";

/** Where a reported track came from, so the UI need not pretend they are equal. */
export type TrackSource = "git" | "formula" | "version" | "unknown";

export type DetectedTrack = { track: string | null; source: TrackSource };

const UNKNOWN: DetectedTrack = { track: null, source: "unknown" };

/**
 * A Homebrew install's track IS the installed formula, so the keg path answers
 * it exactly. Matched on a path segment rather than a substring so a formula
 * whose name contains another's ("stage-utility" inside "stage-utility-beta")
 * cannot win by being checked first.
 */
function fromFormula(appRoot: string): DetectedTrack {
  const segments = appRoot.split(/[\\/]+/);
  if (segments.includes(FORMULA.beta)) return { track: "beta", source: "formula" };
  if (segments.includes(FORMULA.main)) return { track: "main", source: "formula" };
  return UNKNOWN;
}

/**
 * A tarball carries no marker of its track, but beta builds only ever ship a
 * prerelease version — a hyphen in the semver, as in 1.10.0-beta.4. An
 * inference rather than a fact, hence the distinct source.
 */
function fromVersion(version: string): DetectedTrack {
  const v = version.trim();
  if (!v || v === "0.0.0") return UNKNOWN;
  return { track: v.includes("-") ? "beta" : "main", source: "version" };
}

/**
 * The track this install follows.
 *
 * `gitBranch` is only trusted for a git install — see the toplevel check in
 * updater.ts. A packaged install sitting inside someone else's repository (every
 * Homebrew install is: the prefix is a git repo) would otherwise report that
 * repository's branch as its own.
 */
export function detectTrack(o: {
  kind: InstallKind;
  appRoot: string;
  version: string;
  gitBranch: string | null;
}): DetectedTrack {
  if (o.kind === "git") {
    return o.gitBranch ? { track: o.gitBranch, source: "git" } : UNKNOWN;
  }
  if (o.kind === "homebrew") {
    // Fall through to the version when the keg is somewhere unexpected: an
    // inference beats defaulting, and both beat claiming main.
    const byFormula = fromFormula(o.appRoot);
    return byFormula.track ? byFormula : fromVersion(o.version);
  }
  if (o.kind === "tarball") return fromVersion(o.version);
  return UNKNOWN;
}
