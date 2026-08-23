// signage.ts — the digital-signage domain: a media library, playlists, groups of
// displays, schedules, and the resolved plan a screen actually plays.
//
// Signage adds no display model. A signage screen is an Output (already enrolled,
// named, slugged and bound to a kiosk device) routed to a View of kind "signage".
// What each screen PLAYS is resolved per output on the server, so one View drives
// every signage screen however many groups and schedules exist.
//
// See docs/superpowers/specs/2026-08-22-digital-signage-design.md.

export type SignageFit = "contain" | "cover";

export type SignageTransitionKind =
  | "cut"
  | "crossfade"
  | "fade-through-black"
  | "slide"
  | "wipe";

export type SignageDirection = "left" | "right" | "up" | "down";

export interface SignageTransition {
  kind: SignageTransitionKind;
  /** 0-3000. Ignored when kind === "cut". */
  ms: number;
  /** Only meaningful for "slide" and "wipe". */
  direction?: SignageDirection;
}

/**
 * One file in the library.
 *
 * The bytes live at `<userData>/signage-media/<file>` and are served at
 * `/signage-media/<file>`. `file` is content-addressed, so the name is
 * VERIFIABLE rather than trusted — an upload whose name disagreed with its bytes
 * would either overwrite an unrelated file or plant one under a name a playlist
 * already points at.
 */
export interface SignageMedia {
  id: string;
  /** `<sha256-16>.<ext>`. */
  file: string;
  /** The operator's name for it. Defaults to the uploaded filename. */
  name: string;
  mime: string;
  bytes: number;
  /** Intrinsic pixel size, measured client-side and clamped server-side. */
  w: number;
  h: number;
  /** Video only: the clip's own length, which is its item duration. */
  durationMs?: number;
  createdAt: string;
}

export interface SignagePlaylistItem {
  mediaId: string;
  /** Images: overrides the playlist default. Ignored for video, whose duration
   *  is the clip's own length — cutting a clip off at the playlist default is
   *  never what anyone means. */
  durationMs?: number;
  fit?: SignageFit;
  transition?: SignageTransition;
}

export interface SignagePlaylist {
  id: string;
  name: string;
  items: SignagePlaylistItem[];
  /** Applied to any image item without its own. */
  defaultDurationMs: number;
  fit: SignageFit;
  transition: SignageTransition;
  /**
   * Tags this playlist is the FALLBACK for. "Default for" in the UI.
   *
   * Two jobs, and both matter: it plays when no schedule matches instead of the
   * screen going black, AND it is what a display plays when it BOOTS with no
   * server reachable. The second job is why an offline deployment is configured
   * by setting this rather than by writing a schedule — a booting display has no
   * connection to check and a Pi has no RTC, so a window it cannot trust must
   * never be consulted.
   *
   * It lives on the PLAYLIST rather than on the tag because that is where an
   * operator is when they decide it: they have just built the loop, and saying
   * "this is what the foyer shows when nothing else is on" belongs to that
   * moment. Several playlists may claim the same tag — the UI warns and names
   * the winner, which is the first of them in playlist order.
   */
  defaultForGroupIds?: string[];
  createdAt: string;
}

export interface SignageGroup {
  id: string;
  name: string;
  outputIds: string[];
  /**
   * @deprecated Moved to SignagePlaylist.defaultForGroupIds.
   *
   * Read on load and migrated, never written. Kept on the type so the migration
   * can SEE it: dropping the field first would make an operator's existing
   * default silently unreachable, which is the one thing a rename of a concept
   * must not do.
   */
  defaultPlaylistId?: string | null;
  createdAt: string;
}

/**
 * When a schedule is open.
 *
 * Every time-of-day and calendar test is evaluated in the APP time zone
 * (app-timezone.ts), never the host clock: most Linux images run UTC, where the
 * calendar date rolls at 19:00 in Chicago.
 */
export type SignageWindow =
  | { kind: "always" }
  | { kind: "weekly"; days: readonly number[]; start: string; end: string }
  | {
      kind: "dates";
      /** "YYYY-MM-DD", inclusive. */
      from: string;
      /** "YYYY-MM-DD", inclusive. */
      to: string;
      /** Optional weekly pattern inside the range. */
      days?: readonly number[];
      start: string;
      end: string;
    }
  | { kind: "once"; date: string; start: string; end: string }
  | {
      kind: "pco";
      serviceTypeId: string;
      leadMinutes: number;
      trailMinutes: number;
      /** Stay open while PCO Live reports this service type live, so a service
       *  running long does not blank the foyer mid-service. */
      liveExtension: boolean;
    };

export interface SignageSchedule {
  id: string;
  name: string;
  enabled: boolean;
  groupIds: string[];
  playlistId: string;
  window: SignageWindow;
  createdAt: string;
}

/**
 * A live take-over on one group.
 *
 * Stored as RUNTIME rather than config: it must survive a server restart — a
 * dropped announcement is a real failure — but restoring a two-week-old snapshot
 * must never put a forgotten announcement back on a wall.
 */
export interface SignageOverride {
  groupId: string;
  /** Exactly one of these. `blank` is an explicit "show nothing". */
  playlistId?: string;
  blank?: boolean;
  startedAt: number;
  /** Free text for the banner. */
  note?: string;
}

/** One PCO-derived open window, precomputed by signage-pco-windows. */
export interface PcoWindow {
  serviceTypeId: string;
  from: number;
  to: number;
  /** False when this came from cache after a failed fetch. A stale window is
   *  kept and used — failing closed means dark foyer TVs on a Sunday because an
   *  API call timed out — but the UI has to be able to say so. */
  fresh: boolean;
}

/** The live state a window test may consult. */
export interface WindowCtx {
  pcoWindows: PcoWindow[];
  /** The service type PCO Live currently reports live, or null. */
  liveServiceTypeId: string | null;
}

/** Why a horizon entry is what it is. Shown on the Now board and in the log. */
export type SignageReason = "override" | "schedule" | "default" | "blank";

/**
 * One item as it travels to a display: everything the player needs, nothing left
 * to look up.
 *
 * Named rather than inline because two places build it — the resolver, and the
 * renderer's preview entry for the playlist editor and the Now board — and while
 * the shape was anonymous both wrote the mapping out by hand. See
 * toHorizonItems, which is now the only place it is written.
 */
export interface SignageHorizonItem {
  url: string;
  mime: string;
  durationMs: number;
  fit: SignageFit;
  transition: SignageTransition;
  bytes: number;
}

export interface SignageHorizonEntry {
  /** Epoch ms, inclusive. */
  from: number;
  /** Epoch ms, exclusive — so no instant belongs to two entries. */
  until: number;
  /** Absent means blank. */
  playlist?: {
    id: string;
    /** Cycle position is derived from this, so every display in a group agrees.
     *  Moves ONLY when the resolved playlist changes, so a page reload does not
     *  restart the loop. */
    startedAt: number;
    fit: SignageFit;
    transition: SignageTransition;
    items: SignageHorizonItem[];
  };
  reason: SignageReason;
  /** e.g. the winning schedule's name. */
  reasonLabel: string;
  /**
   * The id of whatever decided this — the schedule, the group whose default won,
   * or the overridden group.
   *
   * Carried alongside the label because the label is not unique: two schedules
   * may share a name, and marking "the winning row" by name would light both.
   * Absent on a blank entry, which nothing decided.
   */
  reasonId?: string;
}

/**
 * What one output plays for the next 24 hours: contiguous, non-overlapping and
 * in chronological order.
 *
 * A horizon rather than "what to show now" is what lets a display switch itself
 * at a boundary (so the server pushes on config change, not every boundary),
 * prefetch what is coming, and keep playing when the server goes away.
 */
export type SignageHorizon = SignageHorizonEntry[];

export const MAX_TRANSITION_MS = 3000;
export const DEFAULT_TRANSITION: SignageTransition = { kind: "crossfade", ms: 600 };

/**
 * Per-mime upload ceiling. Membership in this map IS the allowlist — there is no
 * second list to drift from it.
 *
 * SVG is absent on purpose, unlike layout-image-store: an SVG can carry script,
 * and this directory is uploaded to by more people and served from more URLs
 * than a layout image is. The cost is that a logo is uploaded as a PNG.
 */
export const SIGNAGE_MIME_CAPS: Record<string, number> = {
  "image/png": 12 * 1024 * 1024,
  "image/jpeg": 12 * 1024 * 1024,
  "image/webp": 12 * 1024 * 1024,
  "image/gif": 12 * 1024 * 1024,
  "video/mp4": 200 * 1024 * 1024,
  "video/webm": 200 * 1024 * 1024,
};

export const SIGNAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** Extensions the media directory may contain, derived from the allowlist rather
 *  than written out again — the two drifting is how an upload succeeds and the
 *  file it wrote can never be served back. */
export const SIGNAGE_EXTS: readonly string[] = [
  ...new Set(Object.values(SIGNAGE_EXT_BY_MIME)),
];

export function isSignageMime(m: string): boolean {
  // Object.hasOwn, not `SIGNAGE_MIME_CAPS[m] !== undefined`: "constructor" and
  // "toString" are inherited on a plain object and would both read as accepted.
  return Object.hasOwn(SIGNAGE_MIME_CAPS, m);
}

export function isSignageVideo(m: string): boolean {
  return m.startsWith("video/");
}

/**
 * Clamps for values the BROWSER measured (Image.naturalWidth,
 * HTMLVideoElement.duration) and sent along with an upload.
 *
 * Out of range is REJECTED, never defaulted. A zero duration would make a
 * playlist's cycle length unusable, and a default would hide that the
 * measurement failed rather than surfacing it at the door.
 */
export const MAX_MEDIA_DIMENSION = 65535;
export const MIN_ITEM_MS = 100;
export const MAX_ITEM_MS = 86_400_000;
