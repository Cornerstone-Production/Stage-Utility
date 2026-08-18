// What the operator has already been told about updates.
//
// RUNTIME, deliberately. This is an observation, not the operator's work: a
// config snapshot restored from last month must not re-announce a version that
// has since been installed, nor suppress one that has not. It is also why this
// is a DataStore rather than another bare writeFileSync beside `update-track`
// and `update-restart-pending` — those bypass the store registry, and a store
// that is not registered is a store nobody can reason about.

import { DataStore } from "./data-store.js";
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
}

export const UPDATE_NOTICES_DEFAULT: UpdateNotices = {
  announcedTag: null,
  justUpdated: null,
};

export const updateNoticesStore = new DataStore<UpdateNotices>(
  "update-notices.json",
  UPDATE_NOTICES_DEFAULT,
  "runtime",
);
