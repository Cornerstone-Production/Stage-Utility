// running-notes.ts — the release notes of the version RUNNING, for What's new.
//
// The after-update dialog is shown once. What's new reopens the same notes at
// any time, read-only, so this answers one question: what changed in the
// release this server is running? In order:
//
//   1. the notes kept for it (on Dismiss, or after an earlier fetch);
//   2. the after-update notice, while it is still waiting to be dismissed;
//   3. GitHub's release for the running tag, through the release check's
//      conditional cache, kept on success so the next press needs no network.
//
// Never the live update status: that describes the NEXT release, the one an
// update would install, which is exactly the wrong answer with one waiting.
// Every stored candidate must name the running version, because a notice is
// captured before its update runs and may describe a version that never started.
//
// Reading never touches `justUpdated`. That field is the acknowledgement, and
// the after-update dialog comes back, or fails to, on the strength of it.

import { errorMessage, fetchFailureMessage } from "../errors.js";
import { releasePageUrl } from "../github-repo.js";
import { releaseTagOf } from "../release-tags.js";
import { updateNoticesStore, type KeptReleaseNotes } from "../update-notices-store.js";
import { pkgVersion } from "../updater.js";
import { NOTES_CAP, fetchReleaseByTag, fetchReleases, type ReleaseInfo } from "./release-check.js";
import { parseReleaseIntro, parseReleaseSections, type ReleaseSection } from "./release-notes.js";

export type RunningNotes =
  | {
      ok: true;
      /** The running version, as the server reports it (`1.28.1`). */
      version: string;
      releaseUrl: string;
      /** Where the notes came from. For the log and the tests; the dialog
       *  draws both the same. */
      source: "kept" | "notice" | "fetched";
      notes: ReleaseSection[];
      lines: string[];
      intro: string | null;
      /** Set when fetched notes could not be kept: shown this time, fetched
       *  again next time. */
      keepFailed?: string;
    }
  | {
      ok: false;
      version: string;
      releaseUrl: string;
      /** Why, in words for the log. The dialog says only that the notes could
       *  not be loaded. */
      reason: string;
    };

/** Seams for tests. The app passes none. */
export interface RunningNotesDeps {
  version?: () => string;
  fetchReleases?: () => Promise<ReleaseInfo[]>;
  fetchReleaseByTag?: (tag: string) => Promise<ReleaseInfo | null>;
  warn?: (line: string) => void;
}

/** A stored version (`v1.28.1`, or `"unknown"` from a capture with no target)
 *  against the running one (`1.28.1`), as the release tags they name. Two
 *  versions that name no release are not the same release. */
export function sameVersion(a: string, b: string): boolean {
  const tag = releaseTagOf(a);
  return tag !== null && tag === releaseTagOf(b);
}

/** What the kept entry and the after-update notice have in common. */
type StoredNotes = Pick<KeptReleaseNotes, "notes" | "lines" | "intro">;

const hasContent = (n: StoredNotes) =>
  n.notes.length > 0 || n.lines.length > 0 || Boolean(n.intro);

/** The running release in the list, else asked for by tag. The list goes
 *  first because the hourly check keeps its ETags warm, so it usually costs no
 *  quota at all; the by-tag read covers a release the list has crowded out. */
async function findRelease(tag: string, deps: RunningNotesDeps): Promise<ReleaseInfo | null> {
  const listed = (await (deps.fetchReleases ?? fetchReleases)()).find((r) => r.tag === tag);
  return listed ?? (deps.fetchReleaseByTag ?? ((t: string) => fetchReleaseByTag(t)))(tag);
}

export async function runningReleaseNotes(deps: RunningNotesDeps = {}): Promise<RunningNotes> {
  const version = (deps.version ?? pkgVersion)();
  const tag = releaseTagOf(version);
  const releaseUrl = releasePageUrl(tag);
  const warn = deps.warn ?? ((line: string) => console.warn(line));

  const stored = await updateNoticesStore.load();
  const ok = (n: StoredNotes, source: "kept" | "notice" | "fetched"): RunningNotes & { ok: true } =>
    ({ ok: true, version, releaseUrl, source, notes: n.notes, lines: n.lines, intro: n.intro });
  const kept = stored.releaseNotes;
  if (kept && sameVersion(kept.version, version) && hasContent(kept)) return ok(kept, "kept");
  const notice = stored.justUpdated;
  if (notice && sameVersion(notice.version, version) && hasContent(notice)) return ok(notice, "notice");

  // One line per failed fetch, naming the tag and the reason: the dialog says
  // only "could not be loaded", so this is where the why lives.
  const fail = (why: string): RunningNotes => {
    warn(`[updater] could not load the release notes for ${tag ?? `version ${version}`}: ${why}`);
    return { ok: false, version, releaseUrl, reason: why };
  };
  if (!tag) return fail("it is not a release version, so there is no release to read");

  let release: ReleaseInfo | null;
  try {
    release = await findRelease(tag, deps);
  } catch (err) {
    return fail(fetchFailureMessage(err, "api.github.com"));
  }
  if (!release) return fail("GitHub has no release for it");
  const notes = parseReleaseSections(release.body, NOTES_CAP);
  const intro = parseReleaseIntro(release.body);
  // A release that parses to nothing is not drawn as an empty dialog, and is
  // not kept: a release edited later gets another chance.
  if (!notes.length && !intro) return fail("its release notes list no changes");

  const keep: KeptReleaseNotes = { version: tag, notes, lines: [], intro };
  const answer = ok(keep, "fetched");
  try {
    // From `cur`, never from `stored` above: a Dismiss may have landed while the
    // fetch was out, and writing the old snapshot back would undo it.
    await updateNoticesStore.update((cur) => ({ ...cur, releaseNotes: keep }));
    return answer;
  } catch (err) {
    // The notes are in hand, so they are shown; the caller is told they were
    // not kept, and the next press fetches again.
    const why = errorMessage(err);
    warn(`[updater] fetched the release notes for ${tag} but could not keep them: ${why}`);
    return { ...answer, keepFailed: why };
  }
}

/**
 * Dismiss the after-update notice: clear the acknowledgement, keep the notes.
 *
 * The notes are kept only when the notice names the version running. One that
 * does not was captured for an update that failed, and keeping it would
 * replace the running release's notes with another release's. The running
 * version is package.json on disk, so during a deferred restart the notice
 * does match: it describes the build installed and waiting to start, which is
 * what the card's Running line shows too.
 */
export async function dismissJustUpdated(runningVersion: string = pkgVersion()): Promise<void> {
  await updateNoticesStore.update((cur) => {
    const n = cur.justUpdated;
    const keep = n && sameVersion(n.version, runningVersion) && hasContent(n);
    return {
      ...cur,
      justUpdated: null,
      releaseNotes: keep
        ? { version: n.version, notes: n.notes, lines: n.lines, intro: n.intro }
        : cur.releaseNotes,
    };
  });
}
