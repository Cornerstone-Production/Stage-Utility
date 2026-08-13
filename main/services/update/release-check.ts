// release-check.ts — what release a PACKAGED install should be running.
//
// A git checkout learns this from `git fetch` + the tags on its branch. A
// packaged install has no repository to ask, so `checkForUpdate` used to set the
// track and stop — `behind` stayed 0 forever, the UI said "Up to date" with the
// Update button disabled, and the hourly auto-apply never fired. The strategy
// layer could APPLY an update perfectly well; nothing ever DETECTED one.
//
// The releases API is the same source install.sh resolves against, and the
// candidates are ordered by the same tested comparator the git path uses
// (release-tags.ts) — so a packaged box and a checkout agree on what "newest on
// this track" means, prereleases included.

import type { UpdateStatus } from "../../types/stage.js";
import { latestOnTrack, newerThan, parseTag, type ParsedTag } from "../release-tags.js";

const REPO = "Cornerstone-Production/Stage-Utility";
// One page covers both tracks: main wants the newest stable, beta the newest of
// anything, and 30 releases of history is months of either.
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

export interface ReleaseInfo {
  tag: string;
  name: string | null;
  publishedAt: string | null;
}

/**
 * The GitHub response, reduced to what the comparator needs. Tolerant of junk —
 * a rate-limit body is `{message}` not an array, and must read as "no releases"
 * rather than throw. Drafts are skipped: they have no downloadable assets, so
 * offering one would produce an update that cannot install.
 */
export function parseReleases(json: unknown): ReleaseInfo[] {
  if (!Array.isArray(json)) return [];
  const out: ReleaseInfo[] = [];
  for (const r of json) {
    if (typeof r !== "object" || r === null) continue;
    const rec = r as { tag_name?: unknown; name?: unknown; draft?: unknown; published_at?: unknown };
    if (typeof rec.tag_name !== "string" || rec.draft === true) continue;
    out.push({
      tag: rec.tag_name,
      name: typeof rec.name === "string" ? rec.name : null,
      publishedAt: typeof rec.published_at === "string" ? rec.published_at : null,
    });
  }
  return out;
}

/**
 * Derived from UpdateStatus rather than restated, so renaming a status field
 * breaks this type instead of silently unhooking the value from the UI (the
 * call site spreads this into a Partial, where a stray name type-checks fine).
 *
 * `behind`/`behindUserFacing` mirror releasesBehind — a packaged install has no
 * commit distance to report, and those two are what the auto-apply schedule and
 * the pre-tag UI read. Zero and non-zero at exactly the same times.
 */
export type PackagedAvailability = Required<
  Pick<
    UpdateStatus,
  | "tagBased"
  | "currentTag"
  | "targetTag"
  | "releasesBehind"
  | "behind"
  | "behindUserFacing"
  | "unreleasedCommits"
  | "latestSha"
    | "latestDate"
    | "changelog"
  >
>;

/** One cap for every "What's new" list — updater.ts imports this, so the git
 *  and packaged paths cannot drift apart. */
export const CHANGELOG_CAP = 20;

/** Availability for a packaged install: current version vs the published releases. */
export function packagedUpdateStatus(
  releases: ReleaseInfo[],
  track: string,
  currentVersion: string,
): PackagedAvailability {
  const tags = releases.map((r) => r.tag);
  const target = latestOnTrack(tags, track);

  // `v` + the VERSION file. When that isn't a release version (a corrupt file,
  // or updater.ts's "0.0.0" nothing-found fallback — a version no release ever
  // shipped), claiming "up to date" would hide every future release — so an
  // unreadable current version counts as behind whatever is newest, which an
  // update then repairs.
  const v = currentVersion.trim();
  const currentTag = v !== "0.0.0" && parseTag(`v${v}`) ? `v${v}` : null;

  let newer: ParsedTag[];
  if (currentTag) newer = newerThan(tags, track, currentTag);
  else if (target) newer = [target];
  else newer = [];

  const byTag = new Map(releases.map((r) => [r.tag, r]));
  const changelog = newer.slice(0, CHANGELOG_CAP).map((t) => {
    const rel = byTag.get(t.tag);
    // The release name when it says more than the tag; otherwise just the tag.
    return rel?.name && rel.name !== t.tag ? `${t.tag} — ${rel.name}` : t.tag;
  });

  return {
    tagBased: true,
    currentTag,
    targetTag: target?.tag ?? null,
    releasesBehind: newer.length,
    behind: newer.length,
    behindUserFacing: newer.length,
    unreleasedCommits: 0,
    latestSha: null,
    latestDate: (target && byTag.get(target.tag)?.publishedAt) ?? null,
    changelog,
  };
}

/**
 * The published releases, newest first. Throws on network failure or a non-OK
 * response — the caller surfaces that in `status.error`, exactly as the git
 * path surfaces a failed fetch. An unauthenticated GitHub API allows 60
 * requests/hour per address; the hourly auto-check plus a human clicking
 * "Check" stays far inside that.
 */
export async function fetchReleases(): Promise<ReleaseInfo[]> {
  const res = await fetch(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "stage-utility-updater" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Release check failed: GitHub answered ${res.status}`);
  return parseReleases(await res.json());
}
