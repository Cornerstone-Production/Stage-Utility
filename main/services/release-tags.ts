// release-tags.ts — which release a track should be running.
//
// Deployments follow a tag, not the tip of a branch. The release workflow runs
// lint, type-check, tests and build BEFORE it tags, so a tag is verified code;
// the branch tip is whatever merged most recently and may not have finished CI
// — or may have failed it. Following tags is what keeps a red build off a stage
// display on a Sunday morning.
//
// Ordering lives here rather than in `git tag --sort=-v:refname` because git's
// version sort ranks a prerelease ABOVE its own release unless the repo happens
// to set versionsort.suffix:
//
//   $ git tag -l --sort=-v:refname
//   v1.10.0-beta.1     <- git thinks this is newer
//   v1.10.0
//
// That would hand every box a prerelease the moment a stable release shipped.
// The comparator below implements semver precedence and is unit-tested.

/** A release tag, parsed. `pre` is empty for a stable release. */
export interface ParsedTag {
  tag: string;
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers: "beta.2" -> ["beta", 2]. */
  pre: (string | number)[];
}

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse `v1.9.2-beta.3`. Returns null for anything that isn't a release tag. */
export function parseTag(tag: string): ParsedTag | null {
  const m = TAG_RE.exec(tag.trim());
  if (!m) return null;
  const pre = m[4]
    ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number.parseInt(id, 10) : id))
    : [];
  return {
    tag: tag.trim(),
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
    pre,
  };
}

/** Semver precedence: negative when a is older, positive when a is newer. */
export function compareTags(a: ParsedTag, b: ParsedTag): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // A release outranks any prerelease of the same version.
  if (a.pre.length === 0 && b.pre.length > 0) return 1;
  if (a.pre.length > 0 && b.pre.length === 0) return -1;

  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    // A shorter set of identifiers is lower, so beta < beta.1.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else if (typeof x === "number") {
      return -1; // numeric identifiers rank below alphanumeric
    } else if (typeof y === "number") {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export type Track = "main" | "beta";

/**
 * Is this tag a candidate for the track?
 *
 * `main` takes only stable releases. `beta` takes prereleases and stable
 * releases both — a stable release is strictly newer than the betas that led to
 * it, so a beta box must not be held back from it.
 */
export function isOnTrack(t: ParsedTag, track: string): boolean {
  return track === "main" ? t.pre.length === 0 : true;
}

/** The newest tag on the track, or null when the track has none. */
export function latestOnTrack(tags: string[], track: string): ParsedTag | null {
  const eligible = tags
    .map(parseTag)
    .filter((t): t is ParsedTag => t !== null && isOnTrack(t, track));
  if (eligible.length === 0) return null;
  return eligible.reduce((best, t) => (compareTags(t, best) > 0 ? t : best));
}

/** Tags on the track strictly newer than `current` (newest first). */
export function newerThan(tags: string[], track: string, current: string | null): ParsedTag[] {
  const from = current ? parseTag(current) : null;
  return tags
    .map(parseTag)
    .filter((t): t is ParsedTag => t !== null && isOnTrack(t, track))
    .filter((t) => from === null || compareTags(t, from) > 0)
    .sort((a, b) => compareTags(b, a));
}
