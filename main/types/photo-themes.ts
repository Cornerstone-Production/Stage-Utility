// Photo themes: what the server says about themed mic slot photos and the
// OpenAI connection that makes them. Shared by the routes, the SSE channel and
// (in the renderer) the Mic slots page.

/** The SSE channel that carries a {@link PhotoThemesChanged}. */
export const PHOTO_THEMES_CHANNEL = "photo-themes:changed";

/** A theme id as the server issues it. */
export const THEME_ID = /^th-[0-9a-f]{12}$/;

/** A stored edit's file name: the first 16 hex of its SHA-256 and its type. */
export const THEMED_PHOTO_FILE = /^[0-9a-f]{16}\.(?:webp|png)$/;

const THEMED_PHOTO_PATH = "/api/photo-themes/images/";

/** Where a stored edit is served, for review or for a slot. */
export function themedPhotoUrl(file: string): string {
  return THEMED_PHOTO_PATH + file;
}

/**
 * The stored edit a {@link themedPhotoUrl} names, or null. What an approval
 * sends back: the file the operator was shown, so an edit that replaced it
 * meanwhile is never the one approved.
 */
export function themedPhotoFileOf(url: string | null | undefined): string | null {
  if (!url?.startsWith(THEMED_PHOTO_PATH)) return null;
  const file = url.slice(THEMED_PHOTO_PATH.length);
  return THEMED_PHOTO_FILE.test(file) ? file : null;
}

/** The most people one approve-all names: more than any plan's boards hold. */
export const MAX_APPROVE_ALL = 500;

/**
 * How a resolved slot names a themed photo in its `photoUrl`.
 *
 * Every slot draws its photo through `/photos?u=<photoUrl>`, which fetches a
 * Planning Center URL. A value with this prefix is served from the photo theme
 * store instead, so the screens draw a themed photo with no change of their own.
 */
export const THEMED_PHOTO_REF_PREFIX = "photo-theme:";

/** The longest theme name and prompt a save takes. */
export const MAX_THEME_NAME = 80;
export const MAX_THEME_PROMPT = 2000;

/** What a plan's screens show: the Planning Center photos, or the approved themed ones. */
export type PhotoShow = "original" | "themed";

/**
 * One person's photo in one theme, as a card shows it.
 *
 * - `none`: nothing in this theme yet.
 * - `generating`: queued or with OpenAI now.
 * - `ready`: an edit waiting to be reviewed.
 * - `approved`: on screens wherever the theme is shown.
 * - `stale`: approved, but their Planning Center photo has changed since.
 * - `failed`: the last attempt failed; `reason` says why.
 *
 * An approved photo stays on screens while a redo is generating, ready or failed:
 * the card's status is the redo's, and `approved` is still set.
 */
export type ThemedPhotoStatus = "none" | "generating" | "ready" | "approved" | "stale" | "failed";

export interface ApprovedPhotoDTO {
  /** The edit, for review: `/api/photo-themes/images/<file>`. */
  url: string;
  /** The plan it was made for, and that plan's date, when it was made for one. */
  fromPlanId: string | null;
  fromDate: string | null;
  approvedAt: string;
  /** Their Planning Center photo has changed since this was made. */
  stale: boolean;
}

export interface PendingPhotoDTO {
  status: "generating" | "ready" | "failed";
  /** The edit, once there is one. */
  url: string | null;
  /** Why it failed, in words for an operator. */
  reason: string | null;
  /** The plan it is being made for. */
  planId: string | null;
}

export interface ThemePersonDTO {
  /** The Planning Center person id. */
  personId: string;
  name: string;
  status: ThemedPhotoStatus;
  /** Their photo (the edit waiting for review, else the approved one) was made under an
   *  earlier prompt of the theme, was not kept, and is not being made again now. */
  promptChanged: boolean;
  approved: ApprovedPhotoDTO | null;
  pending: PendingPhotoDTO | null;
  /** Their Planning Center photo, for a card to draw beside the edit: the one this server last saw, else the one the edit was made from. Null with none. */
  originalUrl: string | null;
}

export interface ThemePlanUseDTO {
  planId: string;
  serviceTypeId: string;
  sortDate: string | null;
}

export interface ThemeDTO {
  id: string;
  name: string;
  prompt: string;
  /** Somebody's photo in it has `promptChanged`: the prompt changed after it was made, and it has not been redone or kept. */
  promptChanged: boolean;
  createdAt: string;
  /** The last service date that used this theme, as a date in the app's time zone. */
  lastUsedDate: string | null;
  /** Its photos are removed after this day (app time zone): three months after its last use. */
  keptUntil: string;
  /** The plans set to use it. */
  plans: ThemePlanUseDTO[];
  people: ThemePersonDTO[];
}

export interface PlanChoiceDTO {
  planId: string;
  serviceTypeId: string;
  sortDate: string | null;
  themeId: string | null;
  show: PhotoShow;
}

/**
 * How the server's OpenAI connection stands.
 *
 * - `not-connected`: no key saved.
 * - `unchecked`: a key is saved and has not been used or tested since.
 * - `connected`: the last call with it worked.
 * - `invalid-key`: OpenAI rejected it.
 * - `out-of-credits`: it works, but the last edit was refused for credits.
 * - `forbidden`: OpenAI refused it access to image edits.
 * - `unreachable`: the last call could not reach OpenAI.
 */
export type OpenAiState =
  | "not-connected"
  | "unchecked"
  | "connected"
  | "invalid-key"
  | "out-of-credits"
  | "forbidden"
  | "unreachable";

export interface OpenAiConnectionDTO {
  /** How the server is connected. Only an API key exists today. */
  method: "api-key" | null;
  /** The saved key, masked to its last four characters: `sk-…3f2a`. Never the key. */
  hint: string | null;
  state: OpenAiState;
  /** Why it is not connected, in words for an operator. */
  reason: string | null;
  /** When it was last used or tested (ISO). */
  checkedAt: string | null;
}

export interface PhotoThemesDTO {
  themes: ThemeDTO[];
  plans: PlanChoiceDTO[];
  connection: OpenAiConnectionDTO;
  running: number;
  queued: number;
}

/** One person a plan's boards put in a slot, and their photo in the plan's theme. */
export interface PlanPersonDTO extends ThemePersonDTO {
  /** Their Planning Center photo, as a slot would draw it; null for no photo. */
  originalUrl: string | null;
}

export interface PlanPeopleDTO {
  planId: string;
  serviceTypeId: string;
  choice: PlanChoiceDTO | null;
  /** Whose roster the people came from; `unavailable` with a reason when it could not be read. */
  roster: "live" | "plan" | "unavailable";
  reason?: string;
  people: PlanPersonDTO[];
  /** How many a Generate would send to OpenAI: those with no photo in the theme, or whose last one failed. */
  toGenerate: number;
}

/**
 * The generation queue moved, or a theme changed. A page re-reads what it shows
 * when `seq` is not the one after the last it saw, or `epoch` is new.
 */
export interface PhotoThemesChanged {
  epoch: string;
  seq: number;
  running: number;
  queued: number;
  /** Who is being made now or is waiting, sorted. */
  active: { themeId: string; personId: string }[];
  /** How the OpenAI connection stands now: a frame is also sent when only this changed. */
  connection: OpenAiConnectionDTO;
}

/** One edit an approve-all was sent: the person, and the file they were shown. */
export interface ShownEdit {
  personId: string;
  file: string;
}

/**
 * What an approve-all answers. `skipped` are the people sent whose edit is no
 * longer the one they were shown (redone, removed or approved meanwhile): they
 * are left as they are, for another look.
 */
export interface ApproveAllResultDTO {
  approved: number;
  skipped: string[];
}

/** What a generate answers: what it queued, and what it did not send and why. */
export interface GenerateResultDTO {
  queued: number;
  /** Already have a photo in this theme: reused, nothing sent. */
  reused: number;
  skipped: { personId: string; name: string; reason: string }[];
}
