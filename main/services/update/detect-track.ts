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
export type TrackSource = "git" | "formula" | "recorded" | "version" | "unknown";

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
 * The track the updater last launched an update or track-switch on, persisted
 * in the data directory (which outlives every release). Beats the version
 * inference because the inference silently FLIPS: a beta box that takes the
 * stable release it is deliberately offered (a stable outranks the betas that
 * led to it) ends up with a hyphen-less VERSION, reads as "main" from then on,
 * and never sees another beta — with no operator action and no notice.
 */
function fromRecord(recorded: string | null): DetectedTrack {
  const r = recorded?.trim();
  return r === "main" || r === "beta" ? { track: r, source: "recorded" } : UNKNOWN;
}

/**
 * The track this install follows.
 *
 * `gitBranch` is only trusted for a git install — see the toplevel check in
 * updater.ts. A packaged install sitting inside someone else's repository (every
 * Homebrew install is: the prefix is a git repo) would otherwise report that
 * repository's branch as its own.
 *
 * Precedence for packaged installs: the Homebrew formula (a hard fact of what
 * is installed, and still right after an operator switches with plain brew),
 * then the recorded track, then the version inference.
 */
export function detectTrack(o: {
  kind: InstallKind;
  appRoot: string;
  version: string;
  gitBranch: string | null;
  /** Contents of the updater's track record in the data dir, or null. */
  recorded?: string | null;
}): DetectedTrack {
  if (o.kind === "git") {
    return o.gitBranch ? { track: o.gitBranch, source: "git" } : UNKNOWN;
  }
  if (o.kind === "homebrew") {
    // Fall through when the keg is somewhere unexpected: an inference beats
    // defaulting, and both beat claiming main.
    const byFormula = fromFormula(o.appRoot);
    return byFormula.track ? byFormula : orVersion(fromRecord(o.recorded ?? null), o.version);
  }
  if (o.kind === "tarball") return orVersion(fromRecord(o.recorded ?? null), o.version);
  return UNKNOWN;
}

function orVersion(first: DetectedTrack, version: string): DetectedTrack {
  return first.track ? first : fromVersion(version);
}
