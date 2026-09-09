// companion-fingerprint.ts — what a cue remembers about its Companion button.
//
// PURE: no I/O, no engine, no server-only imports. The settings page imports it
// to render the status pill, so nothing here may reach for a file or a socket.
//
// A `companion.press` action stores three coordinates, and coordinates are the
// one thing about a Companion button that does not last: somebody drags a button
// one key over, or inserts a page, and the cue presses whatever is now at p17 r2
// c6. Companion answers 204 for an empty coordinate and 200 for a wrong one, so
// neither case says anything an operator would see.
//
// So the action stores an IDENTITY beside the coordinates:
//
//   pageId     the page's own opaque id, which a renumber does not change
//   actionIds  the ids of the actions the button runs, sorted
//   label      what the button said, refreshed whenever it is confirmed
//
// A control in Companion has no id of its own; its ACTIONS do, and they travel
// with the button when it is moved. companion-reconcile.ts compares the two and
// records what it found in `status`.
//
// EVERYTHING IS A STRING OR A NUMBER, because `Rule.action.params` is
// `Record<string, string | number>` — the same reason a `key-value` param stores
// a JSON object as a string rather than widening the type for one field. So
// `actionIds` is stored comma-joined and `movedFrom` as `p<n> r<n> c<n>`, and
// this module is the only place that knows that.

/** What the last reconcile found. Absent on a rule created before this existed. */
export type CueButtonStatus = "in-place" | "moved" | "missing";

const STATUSES: readonly CueButtonStatus[] = ["in-place", "moved", "missing"];

/** Where a button is, at the coordinates Companion's press API takes. */
export interface ButtonLocation {
  page: number;
  row: number;
  col: number;
}

/** A press action's identity fields, read out of the stored params. */
export interface ButtonFingerprint extends ButtonLocation {
  pageId: string;
  label: string;
  /** Sorted. Empty for a button that runs nothing — see companion-export.ts. */
  actionIds: string[];
  /**
   * null when this rule has never been reconciled — which is every rule created
   * before the fingerprint existed. Null is NOT "missing": the first reconcile
   * adopts it, and refusing to press until then would break working cues on an
   * upgrade.
   */
  status: CueButtonStatus | null;
  /** When the fingerprint last CHANGED, not when it was last looked at. */
  lastSeenAt: string | null;
  /** Where it used to be, when the last reconcile moved it. */
  movedFrom: ButtonLocation | null;
}

/** `p17 r2 c6`. One format, written and read in this file only. */
function encodeLocation(at: ButtonLocation): string {
  return `p${at.page} r${at.row} c${at.col}`;
}

/** The inverse, or null for anything that is not one — including "". */
function decodeLocation(text: unknown): ButtonLocation | null {
  const m = /^p(\d+) r(\d+) c(\d+)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  return { page: Number(m[1]), row: Number(m[2]), col: Number(m[3]) };
}

/** `r2c6` — the coordinate as the pill and the log line say it, page implied. */
export function shortLocation(at: ButtonLocation): string {
  return `r${at.row}c${at.col}`;
}

/**
 * Read the identity out of a press action's params.
 *
 * Tolerant by design: every field is optional, because a rule written by hand,
 * imported before this existed, or restored from an older backup has none of
 * them, and the answer for all three is "adopt it on the next reconcile".
 */
export function readFingerprint(params: Record<string, string | number>): ButtonFingerprint {
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : -1;
  };
  const status = String(params.status ?? "");
  return {
    page: num(params.page),
    row: num(params.row),
    col: num(params.col),
    pageId: String(params.pageId ?? "").trim(),
    label: String(params.label ?? "").trim(),
    actionIds: String(params.actionIds ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort(),
    status: STATUSES.includes(status as CueButtonStatus) ? (status as CueButtonStatus) : null,
    lastSeenAt: String(params.lastSeenAt ?? "").trim() || null,
    movedFrom: decodeLocation(params.movedFrom),
  };
}

/** What a button looks like when the picker or an import has just found it. */
export interface FingerprintSource extends ButtonLocation {
  pageId: string;
  label: string;
  actionIds: readonly string[];
}

/**
 * The params to write for a button that has just been seen.
 *
 * `movedFrom` is written as "" rather than left out when there is none, because
 * these are MERGED over the existing params: omitting the key would leave
 * yesterday's "moved from" beside today's in-place status.
 */
export function fingerprintParams(
  found: FingerprintSource,
  status: CueButtonStatus,
  seenAt: string,
  movedFrom: ButtonLocation | null = null,
): Record<string, string | number> {
  return {
    page: found.page,
    row: found.row,
    col: found.col,
    pageId: found.pageId,
    label: found.label,
    actionIds: [...found.actionIds].sort().join(","),
    status,
    lastSeenAt: seenAt,
    movedFrom: movedFrom ? encodeLocation(movedFrom) : "",
  };
}

/** Do two fingerprints name the same button in the same place? */
export function sameFingerprint(a: ButtonFingerprint, b: ButtonFingerprint): boolean {
  return (
    a.page === b.page &&
    a.row === b.row &&
    a.col === b.col &&
    a.pageId === b.pageId &&
    a.label === b.label &&
    a.status === b.status &&
    a.actionIds.join(",") === b.actionIds.join(",") &&
    encodeLocation(a.movedFrom ?? { page: -1, row: -1, col: -1 }) ===
      encodeLocation(b.movedFrom ?? { page: -1, row: -1, col: -1 })
  );
}

/**
 * The sentence a caller is told when the button is gone.
 *
 * One copy: the 409 body, the action's failure detail and the settings pill all
 * say it, and three wordings for one fact is how one of them stays wrong.
 */
export function missingSentence(f: ButtonFingerprint): string {
  const what = f.label || `the button at ${shortLocation(f)}`;
  return `${what} is no longer on Companion page ${f.page}`;
}
