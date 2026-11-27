// book.ts — the photo themes as they are kept: themes, each person's photo in
// each, and which theme each plan uses. Pure: no I/O, no clock of its own.
//
// Held as Maps in memory, because every key here (a theme id, a person id, a
// plan id) arrives on a request, and as arrays on disk. parseBook is both the
// load and the restore check, so a restored file is held to what a save writes.

import { createHash } from "node:crypto";

import { isCalendarDate } from "../calendar-date.js";
import { isPcoId } from "../pco-path.js";
import { isPcoPersonId } from "../pco-person-id.js";
import { isAllowedPhotoUrl } from "../photo-cache.js";
import { zonedDateKey } from "../app-timezone.js";
import { isRecord } from "../../types/is-record.js";
import {
  MAX_THEME_NAME,
  MAX_THEME_PROMPT,
  THEME_ID,
  THEMED_PHOTO_FILE,
  type PhotoShow,
} from "../../types/photo-themes.js";

/** A photo's source fingerprint: 16 hex of a hash of its Planning Center URL. */
export const FINGERPRINT = /^[0-9a-f]{16}$/;

/** An approved photo: what screens show for this person wherever the theme is shown. */
export interface ApprovedPhoto {
  file: string;
  /** The fingerprint of the Planning Center photo it was made from. */
  madeFrom: string;
  sourceUrl: string;
  /** The plan it was made for, and that plan's date. Null for a redo from the theme itself. */
  planId: string | null;
  serviceDate: string | null;
  approvedAt: string;
  /** A newer Planning Center photo the operator chose to keep this one over ("Keep"). */
  acceptedFrom?: string;
  /** The theme prompt it stands for (see promptKey): the one it was made under, or
   *  the one it was kept under ("Keep these", a move or copy into the theme).
   *  Absent in a book written before it was recorded: then the theme's baselinePrompt. */
  prompt?: string;
}

/** An edit that is not on screens: waiting for review, or a failed attempt. */
export interface PendingPhoto {
  status: "ready" | "failed";
  file?: string;
  reason?: string;
  madeFrom: string;
  sourceUrl: string;
  planId: string | null;
  serviceDate: string | null;
  at: string;
  /** As ApprovedPhoto's: the prompt an edit was made under. */
  prompt?: string;
}

export interface ThemePerson {
  personId: string;
  name: string;
  approved?: ApprovedPhoto;
  pending?: PendingPhoto;
}

export interface Theme {
  id: string;
  name: string;
  prompt: string;
  /** The prompt a photo with no `prompt` of its own stands for: one made before
   *  each photo recorded it. Kept, and written, so such a book still reads. */
  baselinePrompt: string;
  createdAt: string;
  /** The latest service date (app zone) that used it. Only ever moves forward. */
  lastUsedDate: string | null;
  people: Map<string, ThemePerson>;
}

export interface PlanChoice {
  planId: string;
  serviceTypeId: string;
  sortDate: string | null;
  themeId: string | null;
  show: PhotoShow;
}

export interface Book {
  themes: Map<string, Theme>;
  plans: Map<string, PlanChoice>;
}

export interface BookFile {
  version: 1;
  themes: (Omit<Theme, "people"> & { people: ThemePerson[] })[];
  plans: PlanChoice[];
}

export const EMPTY_FILE: BookFile = { version: 1, themes: [], plans: [] };

export function emptyBook(): Book {
  return { themes: new Map(), plans: new Map() };
}

// ── Rules, shared by the routes and the restore check ──────────────────────

/** A request or file broke a rule; `message` says which. */
export class PhotoThemeRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PhotoThemeRefused";
  }
}

function refuse(message: string, status = 400): never {
  throw new PhotoThemeRefused(message, status);
}

// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- a prompt may wrap, so newlines and tabs pass
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A theme name as a save takes it: trimmed, 1 to 80 characters, one line. */
export function themeName(v: unknown, what = "name"): string {
  if (typeof v !== "string") refuse(`${what} must be text`);
  const s = v.trim();
  if (!s) refuse(`${what} must not be empty`);
  if (s.length > MAX_THEME_NAME) refuse(`${what} must be at most ${MAX_THEME_NAME} characters`);
  if (CONTROL.test(s)) refuse(`${what} must be one line of text`);
  return s;
}

/** A prompt as a save takes it: trimmed, 1 to 2000 characters. */
export function themePrompt(v: unknown, what = "prompt"): string {
  if (typeof v !== "string") refuse(`${what} must be text`);
  const s = v.trim();
  if (!s) refuse(`${what} must not be empty`);
  if (s.length > MAX_THEME_PROMPT) refuse(`${what} must be at most ${MAX_THEME_PROMPT} characters`);
  if (CONTROL_BUT_LINES.test(s)) refuse(`${what} must be plain text`);
  return s;
}

/**
 * A name from outside (a Planning Center roster) made into one a save takes:
 * control characters to spaces, trimmed, at most 80 characters. Applied on the
 * way in, so a name the roster holds can never be saved and then refused by the
 * next load.
 */
export function cleanName(raw: string): string {
  const s = raw.replace(new RegExp(CONTROL.source, "g"), " ").replace(/\s+/g, " ").trim().slice(0, MAX_THEME_NAME).trim();
  return s || "Unknown";
}

/** A failure reason made into one a save takes: one line, at most 300 characters. */
export function cleanReason(raw: string): string {
  const s = raw.replace(new RegExp(CONTROL.source, "g"), " ").replace(/\s+/g, " ").trim().slice(0, 300);
  return s || "Could not be made";
}

export function isThemeId(v: unknown): v is string {
  return typeof v === "string" && THEME_ID.test(v);
}

export function isPersonId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 20 && isPcoPersonId(v);
}

export function isPlanId(v: unknown): v is string {
  return isPcoId(v);
}

/** A plan's PCO sort_date: an ISO time, or null for one PCO could not date. */
export function sortDate(v: unknown, what = "sortDate"): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > 40 || !Number.isFinite(Date.parse(v))) refuse(`${what} must be a date and time, or null`);
  return v;
}

function show(v: unknown, what: string): PhotoShow {
  if (v !== "original" && v !== "themed") refuse(`${what} must be "original" or "themed"`);
  return v;
}

function isoTime(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > 40 || !Number.isFinite(Date.parse(v))) refuse(`${what} must be a date and time`);
  return v;
}

function photoFile(v: unknown, what: string): string {
  if (typeof v !== "string" || !THEMED_PHOTO_FILE.test(v)) refuse(`${what} must be the name of a stored photo`);
  return v;
}

function fingerprint(v: unknown, what: string): string {
  if (typeof v !== "string" || !FINGERPRINT.test(v)) refuse(`${what} must be a photo fingerprint`);
  return v;
}

function sourceUrl(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > 2048 || !isAllowedPhotoUrl(v)) refuse(`${what} must be a Planning Center photo address`);
  return v;
}

function optionalPlanId(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  if (!isPlanId(v)) refuse(`${what} must be a Planning Center plan id or null`);
  return v;
}

function reasonText(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > 300 || CONTROL.test(v)) refuse(`${what} must be one line of text`);
  return v;
}

// ── The file ───────────────────────────────────────────────────────────────

function parseApproved(raw: unknown, what: string): ApprovedPhoto {
  if (!isRecord(raw)) refuse(`${what} must be an object`);
  const out: ApprovedPhoto = {
    file: photoFile(raw.file, `${what}'s file`),
    madeFrom: fingerprint(raw.madeFrom, `${what}'s madeFrom`),
    sourceUrl: sourceUrl(raw.sourceUrl, `${what}'s sourceUrl`),
    planId: optionalPlanId(raw.planId, `${what}'s planId`),
    serviceDate: sortDate(raw.serviceDate, `${what}'s serviceDate`),
    approvedAt: isoTime(raw.approvedAt, `${what}'s approvedAt`),
  };
  if (raw.acceptedFrom !== undefined) out.acceptedFrom = fingerprint(raw.acceptedFrom, `${what}'s acceptedFrom`);
  if (raw.prompt !== undefined) out.prompt = fingerprint(raw.prompt, `${what}'s prompt`);
  return out;
}

function parsePending(raw: unknown, what: string): PendingPhoto {
  if (!isRecord(raw)) refuse(`${what} must be an object`);
  if (raw.status !== "ready" && raw.status !== "failed") refuse(`${what}'s status must be "ready" or "failed"`);
  const out: PendingPhoto = {
    status: raw.status,
    madeFrom: fingerprint(raw.madeFrom, `${what}'s madeFrom`),
    sourceUrl: sourceUrl(raw.sourceUrl, `${what}'s sourceUrl`),
    planId: optionalPlanId(raw.planId, `${what}'s planId`),
    serviceDate: sortDate(raw.serviceDate, `${what}'s serviceDate`),
    at: isoTime(raw.at, `${what}'s at`),
  };
  if (raw.status === "ready") out.file = photoFile(raw.file, `${what}'s file`);
  else out.reason = reasonText(raw.reason, `${what}'s reason`);
  if (raw.prompt !== undefined) out.prompt = fingerprint(raw.prompt, `${what}'s prompt`);
  return out;
}

/**
 * The book a file describes, or a PhotoThemeRefused naming the first rule it
 * breaks. Used on load and as the restore check, so a restored file is held to
 * the rules a save is.
 */
export function parseBook(raw: unknown): Book {
  if (!isRecord(raw)) refuse("the photo themes must be an object");
  if (raw.version !== 1) refuse("the photo themes file must be version 1");
  if (!Array.isArray(raw.themes)) refuse("themes must be a list");
  if (!Array.isArray(raw.plans)) refuse("plans must be a list");
  const book = emptyBook();
  raw.themes.forEach((t, i) => {
    const what = `theme ${i + 1}`;
    if (!isRecord(t)) refuse(`${what} must be an object`);
    if (!isThemeId(t.id)) refuse(`${what}'s id is not a theme id`);
    if (book.themes.has(t.id)) refuse(`${what}'s id is listed twice`);
    if (t.lastUsedDate !== null && !isCalendarDate(t.lastUsedDate)) refuse(`${what}'s lastUsedDate must be a date or null`);
    if (!Array.isArray(t.people)) refuse(`${what}'s people must be a list`);
    const people = new Map<string, ThemePerson>();
    t.people.forEach((p, j) => {
      const pw = `${what}, person ${j + 1}`;
      if (!isRecord(p)) refuse(`${pw} must be an object`);
      if (!isPersonId(p.personId)) refuse(`${pw}'s personId is not a Planning Center person id`);
      if (people.has(p.personId)) refuse(`${pw} is listed twice`);
      const person: ThemePerson = { personId: p.personId, name: themeName(p.name, `${pw}'s name`) };
      if (p.approved !== undefined) person.approved = parseApproved(p.approved, `${pw}'s approved photo`);
      if (p.pending !== undefined) person.pending = parsePending(p.pending, `${pw}'s pending photo`);
      people.set(person.personId, person);
    });
    book.themes.set(t.id, {
      id: t.id,
      name: themeName(t.name, `${what}'s name`),
      prompt: themePrompt(t.prompt, `${what}'s prompt`),
      baselinePrompt: themePrompt(t.baselinePrompt, `${what}'s baselinePrompt`),
      createdAt: isoTime(t.createdAt, `${what}'s createdAt`),
      lastUsedDate: t.lastUsedDate as string | null,
      people,
    });
  });
  raw.plans.forEach((p, i) => {
    const what = `plan ${i + 1}`;
    if (!isRecord(p)) refuse(`${what} must be an object`);
    if (!isPlanId(p.planId)) refuse(`${what}'s planId is not a Planning Center plan id`);
    if (book.plans.has(p.planId)) refuse(`${what} is listed twice`);
    if (!isPcoId(p.serviceTypeId)) refuse(`${what}'s serviceTypeId is not a Planning Center id`);
    if (p.themeId !== null && !isThemeId(p.themeId)) refuse(`${what}'s themeId must be a theme id or null`);
    if (p.themeId !== null && !book.themes.has(p.themeId)) refuse(`${what} uses a theme the file does not have`);
    book.plans.set(p.planId, {
      planId: p.planId,
      serviceTypeId: p.serviceTypeId,
      sortDate: sortDate(p.sortDate, `${what}'s sortDate`),
      themeId: p.themeId as string | null,
      show: show(p.show, `${what}'s show`),
    });
  });
  return book;
}

/** The book as the file keeps it. Sorted, so a save that changed nothing writes the same bytes. */
export function serializeBook(book: Book): BookFile {
  return {
    version: 1,
    themes: [...book.themes.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((t) => ({
        ...t,
        people: [...t.people.values()].sort((a, b) => a.personId.localeCompare(b.personId)).map((p) => ({ ...p })),
      })),
    plans: [...book.plans.values()].sort((a, b) => a.planId.localeCompare(b.planId)).map((p) => ({ ...p })),
  };
}

/** A deep copy, so a mutation can be thrown away when its save fails. */
export function cloneBook(book: Book): Book {
  return parseBookTrusted(serializeBook(book));
}

/** parseBook for a file this process wrote itself. */
function parseBookTrusted(file: BookFile): Book {
  return {
    themes: new Map(
      file.themes.map((t) => [
        t.id,
        {
          ...t,
          people: new Map(
            t.people.map((p) => [
              p.personId,
              {
                ...p,
                ...(p.approved ? { approved: { ...p.approved } } : {}),
                ...(p.pending ? { pending: { ...p.pending } } : {}),
              },
            ]),
          ),
        },
      ]),
    ),
    plans: new Map(file.plans.map((p) => [p.planId, { ...p }])),
  };
}

/** A prompt as a photo records it: 16 hex of a hash, so a book does not carry
 *  2000 characters per person. Two prompts that differ by a character differ here. */
export function promptKey(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

/**
 * The person's newest photo (the edit waiting for review, else the approved
 * one) stands for a prompt other than the theme's current one: made before the
 * prompt was changed, and neither redone nor kept since.
 */
export function madeUnderEarlierPrompt(theme: Theme, person: ThemePerson): boolean {
  const newest = person.pending?.file ? person.pending : person.approved;
  if (!newest) return false;
  return (newest.prompt ?? promptKey(theme.baselinePrompt)) !== promptKey(theme.prompt);
}

/** Every stored photo file the book refers to. */
export function referencedFiles(book: Book): Set<string> {
  const out = new Set<string>();
  for (const t of book.themes.values()) {
    for (const p of t.people.values()) {
      if (p.approved) out.add(p.approved.file);
      if (p.pending?.file) out.add(p.pending.file);
    }
  }
  return out;
}

// ── Retention ──────────────────────────────────────────────────────────────

/** How long a theme's photos are kept after its last use, in calendar months. */
export const KEEP_MONTHS = 3;

/** `dateKey` ("YYYY-MM-DD") plus `months` calendar months, the day clamped to the
 *  month's length: Nov 30 plus three months is the last day of February. */
export function addMonths(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** The service date of a plan's sort_date, in the app's time zone. */
export function serviceDay(sortDateIso: string | null): string | null {
  if (!sortDateIso) return null;
  const at = Date.parse(sortDateIso);
  return Number.isFinite(at) ? zonedDateKey(at) : null;
}

/** The last day a theme's photos are kept: three months after the later of the
 *  day it was made and the last service that used it, in the app's time zone. */
export function keptUntil(theme: Pick<Theme, "createdAt" | "lastUsedDate">): string {
  const created = zonedDateKey(Date.parse(theme.createdAt));
  const base = theme.lastUsedDate && theme.lastUsedDate > created ? theme.lastUsedDate : created;
  return addMonths(base, KEEP_MONTHS);
}

/** Move a theme's last-used date forward to `day`, never back. */
export function extendUse(theme: Theme, day: string | null): void {
  if (day && (!theme.lastUsedDate || day > theme.lastUsedDate)) theme.lastUsedDate = day;
}
