// What the operator has already been told about updates.
//
// RUNTIME, deliberately. This is an observation, not the operator's work: a
// config snapshot restored from last month must not re-announce a version that
// has since been installed, nor suppress one that has not. It is also why this
// is a DataStore rather than another bare writeFileSync beside `update-track`
// and `update-restart-pending` — those bypass the store registry, and a store
// that is not registered is a store nobody can reason about.

import { DataStore } from "./data-store.js";
import { isRecord, isStringList } from "./is-record.js";
import type { ReleaseSection } from "./update/release-notes.js";

/** The release the operator has not yet acknowledged. */
export interface JustUpdated {
  /** The version now running. */
  version: string;
  /** What it was before, when that is known. */
  fromVersion: string | null;
  /** Captured BEFORE the update ran — afterwards the live status describes the
   *  NEXT pending release, not this one. */
  notes: ReleaseSection[];
  /** The flat changelog, used only when `notes` is empty — a git checkout's
   *  changelog is commit subjects, which carry no sections. */
  lines: string[];
  /** The release's opening prose, shown above the sections. Notices stored by
   *  an older version have none; the store reads that as null. */
  intro: string | null;
  at: string;
}

export interface UpdateNotices {
  /**
   * The tag already announced, and only once it actually reached somebody.
   *
   * Null until an announcement is delivered. Marking at detection time would
   * spend the announcement on an empty room: an update found at 3am with no
   * client connected would never be mentioned again.
   */
  announcedTag: string | null;
  /** Set when an update completes, cleared when the operator dismisses it. */
  justUpdated: JustUpdated | null;
  /**
   * The notes of a release, kept for What's new.
   *
   * Kept apart from `justUpdated` so dismissing the acknowledgement does not
   * lose the notes. Written only for the version running, on Dismiss or after a
   * fetch, and never at capture time: a capture runs before its update and
   * describes a version that may not start.
   */
  releaseNotes: KeptReleaseNotes | null;
}

/** One release's notes, as What's new draws them. */
export interface KeptReleaseNotes {
  /** The release they belong to: a tag (`v1.28.1`) or a plain version. */
  version: string;
  notes: ReleaseSection[];
  /** A git checkout's commit subjects, used only when `notes` is empty. */
  lines: string[];
  intro: string | null;
}

export const UPDATE_NOTICES_DEFAULT: UpdateNotices = {
  announcedTag: null,
  justUpdated: null,
  releaseNotes: null,
};

/**
 * The sections of a stored list, each rebuilt from fields of the right type.
 * A junk section is dropped rather than failing the whole entry: a heading lost
 * is better than the notes lost. A missing or junk `omitted` reads as 0, which
 * draws no count, and a junk `note` is dropped: the dialog splits it as text.
 */
function sectionsOf(v: unknown): ReleaseSection[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((s): ReleaseSection[] => {
    if (!isRecord(s) || typeof s.section !== "string" || !isStringList(s.lines)) return [];
    return [{
      // The section name is drawn, never dispatched on, so an unknown one from
      // a hand-written release is shown as written.
      section: s.section as ReleaseSection["section"],
      lines: s.lines,
      omitted: typeof s.omitted === "number" ? s.omitted : 0,
      ...(typeof s.note === "string" ? { note: s.note } : {}),
    }];
  });
}

const linesOf = (v: unknown): string[] => (isStringList(v) ? v : []);
const textOf = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A kept entry as stored, or null when it is not one. */
function keptNotesOf(v: unknown): KeptReleaseNotes | null {
  if (!isRecord(v) || typeof v.version !== "string") return null;
  return { version: v.version, notes: sectionsOf(v.notes), lines: linesOf(v.lines), intro: textOf(v.intro) };
}

/** A stored notice, or null when it names no version: both dialogs and Dismiss
 *  compare it, and a notice that cannot be compared would throw in all three. */
function justUpdatedOf(v: unknown): JustUpdated | null {
  if (!isRecord(v) || typeof v.version !== "string") return null;
  return {
    version: v.version,
    fromVersion: textOf(v.fromVersion),
    notes: sectionsOf(v.notes),
    lines: linesOf(v.lines),
    intro: textOf(v.intro),
    at: textOf(v.at) ?? "",
  };
}

/**
 * Whatever the file holds, as today's shape. Total, as DataStore requires: a
 * file written before `releaseNotes` existed (every install updating INTO the
 * build that added it) has no such field, and a hand-edited one may hold
 * anything. A notice missing a list or a version would otherwise throw in
 * What's new, in Dismiss and in the after-update dialog.
 */
function normalizeNotices(raw: unknown): UpdateNotices {
  if (!isRecord(raw)) return UPDATE_NOTICES_DEFAULT;
  return {
    announcedTag: typeof raw.announcedTag === "string" ? raw.announcedTag : null,
    justUpdated: justUpdatedOf(raw.justUpdated),
    releaseNotes: keptNotesOf(raw.releaseNotes),
  };
}

export const updateNoticesStore = new DataStore<UpdateNotices>(
  "update-notices.json",
  UPDATE_NOTICES_DEFAULT,
  "runtime",
  { normalize: normalizeNotices },
);
