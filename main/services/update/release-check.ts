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
import { compareTags, latestOnTrack, newerThan, parseTag, type ParsedTag } from "../release-tags.js";
import { parseReleaseIntro, parseReleaseSections, mergeReleaseSections, type ReleaseSection } from "./release-notes.js";

const REPO = "Cornerstone-Production/Stage-Utility";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
// The list endpoint is newest-first regardless of prerelease flag, so when many
// betas ship between stables the whole first page is prereleases and the newest
// STABLE falls off it — true of this repo at the time of writing (30 betas since
// v1.9.5). A main-track box reading only the page would compute "up to date"
// forever: the exact silent no-op this module exists to fix. /releases/latest is
// GitHub's own "newest stable, no prereleases, no drafts" and cannot be crowded
// out, so it is always merged in.
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface ReleaseInfo {
  tag: string;
  name: string | null;
  publishedAt: string | null;
  /** Asset filenames attached to the release. A release is published BEFORE its
   *  archives finish uploading, so this is how a tarball install tells "there is
   *  a new version" from "there is a new version I can actually install". */
  assets: string[];
  /** The release notes markdown. A packaged install has no git history to read,
   *  so this is the only place it can find out what actually changed — see
   *  changeLinesFrom. */
  body: string | null;
}

/**
 * The GitHub response, reduced to what the comparator needs. Tolerant of junk
 * PER ITEM — a malformed entry is dropped, not fatal. A body that is not an
 * array at all is the caller's problem: fetchReleases treats it as a failed
 * check, because mapping it to "no releases" would overwrite a known
 * "update available" with a silent "up to date" (a rate-limit body is
 * `{message}`, and an intercepting proxy can 200 anything). Drafts are skipped:
 * they have no downloadable assets, so offering one would produce an update
 * that cannot install.
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
      assets: Array.isArray((rec as { assets?: unknown }).assets)
        ? ((rec as { assets: unknown[] }).assets
            .map((a) => (a && typeof a === "object" ? (a as { name?: unknown }).name : null))
            .filter((n): n is string => typeof n === "string"))
        : [],
      body: typeof (rec as { body?: unknown }).body === "string" ? (rec as { body: string }).body : null,
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
    | "changelogSections"
    | "changelogIntro"
    | "awaitingPackage"
  >
>;

/** One cap for every "What's new" list — updater.ts imports this, so the git
 *  and packaged paths cannot drift apart. */
export const CHANGELOG_CAP = 20;

/** The dialog after an update is read once, not glanced at, so it is allowed
 *  more than the status panel's twenty lines. */
export const NOTES_CAP = 60;

/** Availability for a packaged install: current version vs the published releases. */
/**
 * The change lines out of a release's notes, flattened.
 *
 * Delegates to parseReleaseSections so there is ONE definition of what counts
 * as a change and how a line is cleaned up. The status panel wants a flat list;
 * the post-update dialog wants the sections. Two parsers would eventually
 * disagree about which is which.
 *
 * The commit TYPE is deliberately not reconstructed. `## Fixed` holds both
 * `fix` and `perf`, so labelling every line `fix(...)` to match a checkout's
 * display exactly would mean stating something false about perf commits.
 */
export function changeLinesFrom(body: string | null): string[] {
  return parseReleaseSections(body, CHANGELOG_CAP).flatMap((s) => s.lines);
}

export function packagedUpdateStatus(
  releases: ReleaseInfo[],
  track: string,
  currentVersion: string,
  /**
   * Whether the package channel can install a given release RIGHT NOW. A
   * release is published before its archives finish uploading and before the
   * Homebrew tap is regenerated; offering one during that window produces an
   * update that 404s or a `brew upgrade` that silently does nothing. Default:
   * everything is installable, which is what a caller that cannot tell should
   * assume.
   */
  installable: (r: ReleaseInfo) => boolean = () => true,
): PackagedAvailability {
  const tags = releases.map((r) => r.tag);
  // What an update would actually land on, and what merely EXISTS. When they
  // differ the newer one is still building — reported, not silently ignored,
  // because "cannot install it yet" and "up to date" look identical otherwise.
  const target = latestOnTrack(releases.filter(installable).map((r) => r.tag), track);
  const newest = latestOnTrack(tags, track);
  const awaitingPackage =
    newest && (!target || compareTags(newest, target) > 0) ? newest.tag : null;

  // `v` + the VERSION file. When that isn't a release version (a corrupt file,
  // or updater.ts's "0.0.0" nothing-found fallback — a version no release ever
  // shipped), claiming "up to date" would hide every future release — so an
  // unreadable current version counts as behind whatever is newest, which an
  // update then repairs.
  const v = currentVersion.trim();
  const currentTag = v !== "0.0.0" && parseTag(`v${v}`) ? `v${v}` : null;

  const installableTags = releases.filter(installable).map((r) => r.tag);
  let newer: ParsedTag[];
  if (currentTag) newer = newerThan(installableTags, track, currentTag);
  else if (target) newer = [target];
  else newer = [];

  const byTag = new Map(releases.map((r) => [r.tag, r]));
  // What actually changed, not just which versions exist. A git checkout reads
  // commit subjects out of its own history; a packaged install has no history,
  // and used to list bare tags — "v1.10.0, v1.10.0-beta.38, v1.10.0-beta.37"
  // told an operator nothing they could act on, while the same box's git
  // sibling showed the real subjects. The release notes carry those lines, so
  // read them from there and the two panels say the same thing.
  const changelog: string[] = [];
  // The same changes, grouped. A box three releases behind installs all three,
  // so the dialog afterwards has to describe all three.
  const sectionLists: ReleaseSection[][] = [];
  for (const t of newer) {
    if (changelog.length >= CHANGELOG_CAP) break;
    const rel = byTag.get(t.tag);
    const sections = parseReleaseSections(rel?.body ?? null, NOTES_CAP);
    if (sections.length) sectionLists.push(sections);
    const lines = changeLinesFrom(rel?.body ?? null);
    if (lines.length) changelog.push(...lines);
    // No notes, or notes with no change list (a hand-written release): the tag
    // is still better than nothing.
    else changelog.push(rel?.name && rel.name !== t.tag ? `${t.tag} — ${rel.name}` : t.tag);
  }
  changelog.length = Math.min(changelog.length, CHANGELOG_CAP);

  return {
    tagBased: true,
    changelogSections: mergeReleaseSections(sectionLists, NOTES_CAP),
    // The NEWEST release's opening prose only. Three releases at once would
    // otherwise stack three "nothing to do to install this" paragraphs, and the
    // one that matters is the version actually being installed.
    changelogIntro: parseReleaseIntro(byTag.get(newer[0]?.tag ?? "")?.body ?? null),
    currentTag,
    targetTag: target?.tag ?? null,
    releasesBehind: newer.length,
    behind: newer.length,
    behindUserFacing: newer.length,
    unreleasedCommits: 0,
    awaitingPackage,
    latestSha: null,
    latestDate: (target && byTag.get(target.tag)?.publishedAt) ?? null,
    changelog,
  };
}

/** The fetch signature this module needs — injectable so tests can serve
 *  canned responses without touching the network. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function getJson(url: string, doFetch: FetchLike): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  return doFetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "stage-utility-updater" },
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * The published releases (newest first), with the newest stable guaranteed
 * present even when the first page is all prereleases — see LATEST_URL.
 *
 * Throws on network failure, a non-OK response, or a 200 whose body is not the
 * releases array — the caller surfaces that in `status.error`, exactly as the
 * git path surfaces a failed fetch. Anything else would let a bad answer
 * overwrite the last known numbers with a silent "up to date". The one
 * tolerated failure is 404 from /releases/latest, which is GitHub's answer for
 * "no stable release exists" (a fork that has only ever shipped prereleases).
 *
 * Two requests per check; an unauthenticated GitHub API allows 60/hour per
 * address, so the hourly auto-check plus a human clicking "Check" stays far
 * inside that.
 */
export async function fetchReleases(doFetch: FetchLike = fetch): Promise<ReleaseInfo[]> {
  const page = await getJson(RELEASES_URL, doFetch);
  if (!page.ok) throw new Error(`Release check failed: GitHub answered ${page.status}`);
  const body = await page.json();
  if (!Array.isArray(body)) {
    const msg = (body as { message?: unknown } | null)?.message;
    throw new Error(
      `Release check failed: unexpected response${typeof msg === "string" ? ` — ${msg}` : ""}`,
    );
  }
  const releases = parseReleases(body);

  const latest = await getJson(LATEST_URL, doFetch);
  if (latest.ok) {
    for (const r of parseReleases([await latest.json()])) {
      if (!releases.some((have) => have.tag === r.tag)) releases.push(r);
    }
  } else if (latest.status !== 404) {
    // A main-track box answers from exactly this endpoint; failing silently
    // here would be the same invisible no-op the page-only bug produced.
    throw new Error(`Release check failed: GitHub answered ${latest.status} for the newest stable`);
  }
  return releases;
}
