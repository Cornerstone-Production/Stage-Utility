// service.ts — photo themes: themed mic slot photos for a service, made by OpenAI
// from each person's Planning Center photo and approved by a person before any
// screen shows one.
//
// What it owns:
//   - the book (book.ts), kept in photo-themes.json, a "config" store: prompts,
//     approvals and which theme each plan uses are the operator's work;
//   - the edits themselves, content-addressed under photo-theme-images/, carried
//     by the config snapshot beside branding and layout images;
//   - a small queue that sends edits to OpenAI two at a time;
//   - the daily retention sweep.
//
// What screens draw comes from shownPhotos(): the plan's theme, only while the
// plan is switched to Themed, only approved photos. StageController.resolve()
// asks it for every resolution, so no surface substitutes on its own.
//
// Every write goes through one queue (`mutate`), and so does everything that
// reads the book to decide what to delete (the sweep, the file tidy), so a
// finished edit can never be tidied away between being saved and being recorded.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { zonedDateKey } from "../app-timezone.js";
import { setAvatarGeometry, withoutAvatarGeometry } from "../avatar-geometry.js";
import { broadcast, channelHasSubscribers } from "../broadcaster.js";
import { DataStore } from "../data-store.js";
import { errorMessage } from "../errors.js";
import { contentName, imageDir, listImages, readImage, saveImageBytes, storedImageProblem } from "../image-files.js";
import { checked } from "../restore-check.js";
import { scrub, scrubError } from "../scrub.js";
import { loadSharp } from "../sharp-load.js";
import { WriteQueue } from "../write-queue.js";
import {
  PHOTO_THEMES_CHANNEL,
  THEMED_PHOTO_FILE,
  THEMED_PHOTO_REF_PREFIX,
  themedPhotoUrl,
  type ApproveAllResultDTO,
  type GenerateResultDTO,
  type PhotoShow,
  type PhotoThemesChanged,
  type PhotoThemesDTO,
  type PlanChoiceDTO,
  type PlanPeopleDTO,
  type ShownEdit,
  type ThemeDTO,
  type ThemePersonDTO,
  type ThemedPhotoStatus,
} from "../../types/photo-themes.js";
import { isAllowedPhotoUrl } from "../photo-cache.js";
import {
  EMPTY_FILE,
  cleanName,
  cleanReason,
  KEEP_MONTHS,
  PhotoThemeRefused,
  addMonths,
  cloneBook,
  emptyBook,
  extendUse,
  keptUntil,
  madeUnderEarlierPrompt,
  parseBook,
  promptKey,
  referencedFiles,
  serializeBook,
  serviceDay,
  themeName,
  themePrompt,
  type Book,
  type BookFile,
  type PlanChoice,
  type Theme,
  type ThemePerson,
} from "./book.js";
import { editImage, type FailureKind } from "./openai-client.js";
import { OpenAiConnection } from "./openai-connection.js";

export { PhotoThemeRefused } from "./book.js";

/** Where the edits are kept, under the data directory. */
export const PHOTO_THEME_IMAGE_DIR = "photo-theme-images";

/** Edits sent to OpenAI at once. */
export const MAX_RUNNING = 2;
/** A rate-limited edit is tried this many more times before it fails. */
const RATE_LIMIT_RETRIES = 2;
/** How long a rate-limited queue waits when OpenAI does not say, and at most. */
const DEFAULT_RETRY_MS = 20_000;
const MAX_RETRY_MS = 60_000;
/** The longest edge of the original sent for an edit. */
const ORIGINAL_EDGE = 1024;
/** The largest original decoded. A Planning Center photo is about 1000 px square. */
const MAX_ORIGINAL_PIXELS = 50_000_000;

/** A failure that says the rest of the run would fail the same way. */
const FATAL = new Set<FailureKind>(["invalid-key", "out-of-credits", "forbidden"]);

const restoreCheck = checked((raw) => serializeBook(parseBook(raw)));

const store = new DataStore<BookFile>("photo-themes.json", EMPTY_FILE, "config", { restoreCheck });

/** A photo's fingerprint: what identifies the upload, not a rendering of it. A
 *  Planning Center avatar URL names the upload (`/person/<id>-<uploaded>/…`), so
 *  a new photo is a new URL and no download is needed to notice one. */
export function photoFingerprint(url: string): string {
  return createHash("sha256").update(withoutAvatarGeometry(url)).digest("hex").slice(0, 16);
}

/** A person a plan's boards put in a slot. */
export interface PlanPerson {
  personId: string;
  name: string;
  photoUrl: string | null;
}

export interface PlanPeopleRead {
  roster: "live" | "plan" | "unavailable";
  reason?: string;
  people: PlanPerson[];
}

/** What the service needs from the rest of the server. Wired in server.ts. */
export interface PhotoThemesDeps {
  /** The people a plan's shown boards put in a slot, deduped. */
  planPeople(serviceTypeId: string, planId: string): Promise<PlanPeopleRead>;
  /** A person's current Planning Center photo, where this server has seen it. */
  currentPhotoOf(personId: string): string | undefined;
  /** The current plan's sort_date, for a plan choice saved without one. */
  currentPlanSortDate(planId: string): string | null;
  /** Something screens draw changed: re-resolve and broadcast. */
  onShownChanged(): void;
  /** The original photo's bytes, or null when it cannot be had. */
  loadOriginal?(url: string): Promise<Buffer | null>;
  /** Tests: OpenAI's fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Job {
  id: number;
  key: string;
  themeId: string;
  personId: string;
  name: string;
  sourceUrl: string;
  planId: string | null;
  serviceDate: string | null;
  runId: number;
  attempts: number;
  notBefore: number;
  /** The prompt the edit was sent with, once it has been: what the result records. */
  prompt?: string;
}

interface Run {
  label: string;
  themeName: string;
  made: number;
  failed: number;
  reused: number;
  skipped: number;
  outstanding: number;
}

const NO_PHOTOS: ReadonlyMap<string, string> = new Map();

const jobKey = (themeId: string, personId: string) => `${themeId}\u0000${personId}`;

async function defaultLoadOriginal(url: string): Promise<Buffer | null> {
  // Through the photo cache, so the original is fetched the way every slot's is
  // (host allowlist, size cap, no redirects) and kept for the next edit.
  const { getPhotoPath } = await import("../photo-cache.js");
  const file = await getPhotoPath(setAvatarGeometry(url, `${ORIGINAL_EDGE}x${ORIGINAL_EDGE}`));
  return file ? fs.readFile(file) : null;
}

/** The original as PNG, its long edge at most 1024 px: what an edit is sent. */
async function toPng(bytes: Buffer): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(bytes, { failOn: "error", limitInputPixels: MAX_ORIGINAL_PIXELS })
    .rotate()
    .resize({ width: ORIGINAL_EDGE, height: ORIGINAL_EDGE, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

/** An edit's bytes as a type the store keeps: the one whose content check they
 *  pass, the same check saveImageBytes makes before it writes them. */
function editExtension(bytes: Buffer): "webp" | "png" | null {
  return (["webp", "png"] as const).find((ext) => storedImageProblem(contentName(bytes, ext), bytes, { checkContent: true }) === null) ?? null;
}

export class PhotoThemesService {
  readonly connection: OpenAiConnection;
  private deps: PhotoThemesDeps | null = null;
  private writes = new WriteQueue();
  private readonly epoch = randomBytes(8).toString("hex");
  private seq = 0;
  private nextJobId = 1;
  private nextRunId = 1;
  private pumpTimer: NodeJS.Timeout | null = null;
  private sweepBootTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  // What resetState() sets: everything a fresh start begins without.
  private book!: Book;
  /** Why the file could not be used, when it could not: nothing is saved over it. */
  private unusable!: string | null;
  private paused!: boolean;
  private stopped!: boolean;
  private queue!: Job[];
  /** Running jobs, by (theme, person). enqueue() refuses a key here, so two jobs never share one. */
  private running!: Map<string, Job>;
  /** The job each (theme, person) is waiting on. A finished job no longer here was
   *  removed, moved or deleted meanwhile, and its result is not kept. */
  private expected!: Map<string, number>;
  private runs!: Map<number, Run>;
  private holdUntil!: number;
  /** Photos seen on rosters read here, for noticing a newer one. */
  private seen!: Map<string, string>;
  private shownCache!: Map<string, ReadonlyMap<string, string>>;
  private shownSignature!: string;
  /** Files the book names that are not on disk (see findMissingFiles). */
  private missing!: Set<string>;

  constructor() {
    // A key saved, removed or refused goes out on the channel: the Integrations tile
    // and every open Theme photos sheet follow it without a reload.
    this.connection = new OpenAiConnection(
      () => this.now(),
      () => this.changedNow(),
    );
    this.resetState();
  }

  private resetState(): void {
    this.book = emptyBook();
    this.unusable = null;
    this.paused = false;
    this.stopped = false;
    this.queue = [];
    this.running = new Map();
    this.expected = new Map();
    this.runs = new Map();
    this.holdUntil = 0;
    this.seen = new Map();
    this.shownCache = new Map();
    this.shownSignature = "";
    this.missing = new Set();
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }

  /** Load the book and the key, and start the daily sweep. Call once, at boot. */
  async start(deps: PhotoThemesDeps, opts: { sweep?: boolean } = {}): Promise<void> {
    this.deps = deps;
    this.stopped = false;
    await this.connection.start();
    const raw = await store.load();
    const unreadable = store.unreadable();
    if (unreadable) {
      this.unusable = unreadable.message;
    } else {
      try {
        this.book = parseBook(raw);
      } catch (err) {
        // Left on disk as it is, and never saved over: a hand edit or a damaged
        // file is the operator's to fix or restore, not ours to replace.
        this.unusable = `photo-themes.json could not be used (${errorMessage(err)})`;
        console.error(`[photo-theme] ${scrub(this.unusable)}; theme photos are off until it is fixed or restored`);
      }
    }
    await this.findMissingFiles();
    this.shownSignature = this.signature();
    if (opts.sweep !== false) this.startSweeps();
  }

  /**
   * Approved photos whose file is not in photo-theme-images/: a restore of a
   * book without its images, or a file removed by hand. A slot given one would
   * draw a broken image where the person's own photo belongs, so shownPhotos
   * leaves them out and they show their original.
   */
  private async findMissingFiles(): Promise<void> {
    const present = new Set(await listImages(PHOTO_THEME_IMAGE_DIR));
    this.missing = new Set([...referencedFiles(this.book)].filter((f) => !present.has(f)));
    if (this.missing.size > 0) {
      console.warn(
        `[photo-theme] ${scrub(this.missing.size)} stored photo(s) are missing from ${scrub(PHOTO_THEME_IMAGE_DIR)}/; the people they belong to show their original photo until they are redone`,
      );
    }
  }

  /** Stop the timers and drop the queue. */
  stop(): void {
    this.stopped = true;
    this.stopSweeps();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    this.queue = [];
  }

  /**
   * Hold every write while a config restore lands. A finished edit is not
   * recorded while held, and the sweep does not run. Resolves once any write
   * in flight has landed; the function it gives back resumes.
   */
  async pause(): Promise<() => void> {
    this.paused = true;
    this.stopSweeps();
    await this.writes.enqueue(async () => undefined);
    return () => {
      this.paused = false;
      if (!this.stopped) {
        this.startSweeps();
        this.pump();
      }
    };
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  /** What a plan's screens draw instead of a person's Planning Center photo. */
  shownPhotos(planId: string | null): ReadonlyMap<string, string> {
    if (!planId) return NO_PHOTOS;
    const cached = this.shownCache.get(planId);
    if (cached) return cached;
    const choice = this.book.plans.get(planId);
    const theme = choice?.themeId ? this.book.themes.get(choice.themeId) : undefined;
    let out: ReadonlyMap<string, string> = NO_PHOTOS;
    if (choice && theme && choice.show === "themed") {
      const m = new Map<string, string>();
      for (const p of theme.people.values()) {
        if (p.approved && !this.missing.has(p.approved.file)) m.set(p.personId, THEMED_PHOTO_REF_PREFIX + p.approved.file);
      }
      out = m;
    }
    this.shownCache.set(planId, out);
    return out;
  }

  state(): PhotoThemesDTO {
    return {
      themes: [...this.book.themes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((t) => this.themeDto(t)),
      plans: [...this.book.plans.values()].map(choiceDto),
      connection: this.connection.status(),
      running: this.running.size,
      queued: this.queue.length,
    };
  }

  /** The channel's frame. Built on demand: the hello burst and a broadcast with somebody listening. */
  changed(): PhotoThemesChanged {
    const active = [...this.running.values(), ...this.queue]
      .map((j) => ({ themeId: j.themeId, personId: j.personId }))
      .sort((a, b) => a.themeId.localeCompare(b.themeId) || a.personId.localeCompare(b.personId));
    return { epoch: this.epoch, seq: this.seq, running: this.running.size, queued: this.queue.length, active, connection: this.connection.status() };
  }

  /** A stored edit, for review or for a slot. */
  async readImage(file: string): Promise<{ data: Buffer; mime: string } | null> {
    if (!THEMED_PHOTO_FILE.test(file)) return null;
    return readImage(PHOTO_THEME_IMAGE_DIR, file);
  }

  /** A plan's people and their photo in the plan's theme. */
  async planPeople(planId: string, serviceTypeId: string): Promise<PlanPeopleDTO> {
    const read = await this.deps!.planPeople(serviceTypeId, planId);
    this.see(read.people);
    const choice = this.book.plans.get(planId) ?? null;
    const theme = choice?.themeId ? this.book.themes.get(choice.themeId) : undefined;
    const people = read.people.map((p) => ({
      ...(theme ? this.personDto(theme, p.personId, p.name) : noneDto(p.personId, p.name)),
      originalUrl: p.photoUrl,
    }));
    return {
      planId,
      serviceTypeId,
      choice: choice ? choiceDto(choice) : null,
      roster: read.roster,
      ...(read.reason ? { reason: read.reason } : {}),
      people,
      // What a press would send, by the rule generate() applies: the buttons' counts are what they bill.
      toGenerate: theme ? read.people.filter((p) => this.wouldSend(theme, p, "missing") === "send").length : 0,
      toRedoAll: theme ? read.people.filter((p) => this.wouldSend(theme, p, "all") === "send").length : 0,
    };
  }

  private themeDto(t: Theme): ThemeDTO {
    return {
      id: t.id,
      name: t.name,
      prompt: t.prompt,
      promptChanged: [...t.people.values()].some((p) => this.promptChangedFor(t, p)),
      createdAt: t.createdAt,
      lastUsedDate: t.lastUsedDate,
      keptUntil: keptUntil(t),
      plans: [...this.book.plans.values()]
        .filter((p) => p.themeId === t.id)
        .map((p) => ({ planId: p.planId, serviceTypeId: p.serviceTypeId, sortDate: p.sortDate })),
      people: [...t.people.values()].map((p) => this.personDto(t, p.personId, p.name)),
    };
  }

  private personDto(t: Theme, personId: string, name: string): ThemePersonDTO {
    const entry = t.people.get(personId);
    const key = jobKey(t.id, personId);
    const generating = this.running.has(key) || this.queue.some((j) => j.key === key);
    const stale = entry?.approved ? this.isStale(entry) : false;
    const promptChanged = entry ? this.promptChangedFor(t, entry) : false;
    let status: ThemedPhotoStatus = "none";
    if (generating) status = "generating";
    else if (entry?.pending) status = entry.pending.status;
    else if (entry?.approved) status = stale ? "stale" : "approved";
    return {
      personId,
      name: entry?.name ?? name,
      // What Manage themes draws beside the edit: their photo as this server last saw it, else what the edit was made from.
      originalUrl: this.currentPhoto(personId) ?? entry?.approved?.sourceUrl ?? entry?.pending?.sourceUrl ?? null,
      status,
      promptChanged,
      approved: entry?.approved
        ? {
            url: themedPhotoUrl(entry.approved.file),
            fromPlanId: entry.approved.planId,
            fromDate: entry.approved.serviceDate,
            approvedAt: entry.approved.approvedAt,
            stale,
          }
        : null,
      pending: generating
        ? { status: "generating", url: null, reason: null, planId: this.jobFor(key)?.planId ?? null }
        : entry?.pending
          ? {
              status: entry.pending.status,
              url: entry.pending.file ? themedPhotoUrl(entry.pending.file) : null,
              reason: entry.pending.reason ?? null,
              planId: entry.pending.planId,
            }
          : null,
    };
  }

  /** Their photo was made under an earlier prompt, and is not being made again now. */
  private promptChangedFor(t: Theme, p: ThemePerson): boolean {
    return !this.expected.has(jobKey(t.id, p.personId)) && madeUnderEarlierPrompt(t, p);
  }

  private jobFor(key: string): Job | undefined {
    return this.running.get(key) ?? this.queue.find((j) => j.key === key);
  }

  private currentPhoto(personId: string): string | undefined {
    return this.deps?.currentPhotoOf(personId) ?? this.seen.get(personId);
  }

  /** Approved, but made from a Planning Center photo older than the one they have now. */
  private isStale(entry: ThemePerson): boolean {
    const current = this.currentPhoto(entry.personId);
    if (!current || !entry.approved) return false;
    const fp = photoFingerprint(current);
    return fp !== entry.approved.madeFrom && fp !== entry.approved.acceptedFrom;
  }

  private see(people: PlanPerson[]): void {
    for (const p of people) if (p.photoUrl) this.seen.set(p.personId, p.photoUrl);
  }

  // ── Themes ──────────────────────────────────────────────────────────────

  async createTheme(body: { name: unknown; prompt: unknown }): Promise<ThemeDTO> {
    const name = themeName(body.name);
    const prompt = themePrompt(body.prompt);
    const id = `th-${randomBytes(6).toString("hex")}`;
    await this.mutate((b) => {
      b.themes.set(id, {
        id,
        name,
        prompt,
        baselinePrompt: prompt,
        createdAt: new Date(this.now()).toISOString(),
        lastUsedDate: null,
        people: new Map(),
      });
    });
    console.log(`[photo-theme] theme "${scrub(name)}" created`);
    return this.themeDto(this.book.themes.get(id)!);
  }

  async updateTheme(id: string, body: { name?: unknown; prompt?: unknown }): Promise<ThemeDTO> {
    if (body.name === undefined && body.prompt === undefined) throw new PhotoThemeRefused("send a name, a prompt or both");
    const name = body.name === undefined ? undefined : themeName(body.name);
    const prompt = body.prompt === undefined ? undefined : themePrompt(body.prompt);
    await this.mutate((b) => {
      const t = themeIn(b, id);
      if (name !== undefined) t.name = name;
      if (prompt !== undefined) {
        // A theme with no photos yet has nothing to redo or keep: the new
        // prompt is simply what they will be made with.
        if (![...t.people.values()].some((p) => p.approved || p.pending?.file)) t.baselinePrompt = prompt;
        t.prompt = prompt;
      }
    });
    return this.themeDto(this.book.themes.get(id)!);
  }

  /** Keep the photos made under an earlier prompt, everyone's, on every plan: "Keep these". */
  async keepPrompt(id: string): Promise<ThemeDTO> {
    await this.mutate((b) => {
      const t = themeIn(b, id);
      t.baselinePrompt = t.prompt;
      const key = promptKey(t.prompt);
      for (const p of t.people.values()) {
        if (p.approved) p.approved.prompt = key;
        if (p.pending) p.pending.prompt = key;
      }
    });
    return this.themeDto(this.book.themes.get(id)!);
  }

  async deleteTheme(id: string): Promise<{ plans: number; photos: number }> {
    let plans = 0;
    let photos = 0;
    let name = "";
    await this.mutate((b, _saved, afterSave) => {
      const t = themeIn(b, id);
      name = t.name;
      photos = [...t.people.values()].filter((p) => p.approved).length;
      for (const p of b.plans.values()) {
        if (p.themeId === id) {
          p.themeId = null;
          plans++;
        }
      }
      b.themes.delete(id);
      afterSave(() => this.cancelTheme(id));
    });
    console.log(
      `[photo-theme] theme "${scrub(name)}" deleted with ${scrub(photos)} approved photo(s); ${scrub(plans)} plan(s) back to their original photos`,
    );
    return { plans, photos };
  }

  // ── Plans ───────────────────────────────────────────────────────────────

  /** Apply a theme to a plan (or none), and switch it between Original and Themed. */
  async choosePlan(
    planId: string,
    body: { serviceTypeId: string; sortDate: string | null | undefined; themeId?: string | null; show?: PhotoShow },
  ): Promise<PlanChoiceDTO> {
    await this.mutate((b) => {
      const prior = b.plans.get(planId);
      const sortDate = body.sortDate ?? prior?.sortDate ?? this.deps?.currentPlanSortDate(planId) ?? null;
      const choice: PlanChoice = prior
        ? { ...prior, serviceTypeId: body.serviceTypeId, sortDate }
        : { planId, serviceTypeId: body.serviceTypeId, sortDate, themeId: null, show: "themed" };
      if (body.themeId !== undefined) {
        if (body.themeId !== null) themeIn(b, body.themeId);
        // A theme chosen shows its approved photos at once; the switch is
        // there to go back to the originals.
        if (body.themeId !== choice.themeId && body.themeId !== null) choice.show = "themed";
        choice.themeId = body.themeId;
      }
      if (body.show !== undefined) choice.show = body.show;
      if (choice.themeId) extendUse(themeIn(b, choice.themeId), serviceDay(choice.sortDate));
      if (choice.sortDate === null && choice.themeId) {
        console.log(`[photo-theme] plan ${scrub(planId)} uses a theme with no service date known; its photos are not aged out while that is so`);
      }
      b.plans.set(planId, choice);
    });
    return choiceDto(this.book.plans.get(planId)!);
  }

  // ── People ──────────────────────────────────────────────────────────────

  /**
   * Approve the ready edit the operator was shown (`file`): it replaces any
   * approved photo, and goes on screens. Checked again inside the write, after
   * the roster read: an edit that replaced the shown one meanwhile (a Redo that
   * landed) is refused, never approved unseen.
   */
  async approve(themeId: string, personId: string, file: string): Promise<ThemePersonDTO> {
    const entry = this.entry(themeId, personId);
    if (entry.pending?.status !== "ready") throw new PhotoThemeRefused("There is no edit waiting for review", 409);
    const turnOn = await this.plansToTurnOn(themeId, entry.pending.planId ? [entry.pending.planId] : []);
    await this.mutate((b) => {
      const t = themeIn(b, themeId);
      if (!isShownEdit(t, personId, file)) throw new PhotoThemeRefused("Their edit changed since it was shown: look at it again", 409);
      promote(t, personId, this.now());
      for (const planId of turnOn) b.plans.get(planId)!.show = "themed";
    });
    return this.personDto(this.book.themes.get(themeId)!, personId, entry.name);
  }

  /**
   * Approve the edits the operator was shown for this plan, each by the file
   * they saw. One that is no longer that file, or no longer waiting for review
   * for this plan, is skipped and named; none left to approve is refused.
   */
  async approveAll(planId: string, shown: readonly ShownEdit[]): Promise<ApproveAllResultDTO> {
    const choice = this.book.plans.get(planId);
    if (!choice?.themeId) throw new PhotoThemeRefused("This plan has no theme", 409);
    const themeId = choice.themeId;
    const turnOn = await this.plansToTurnOn(themeId, [planId]);
    let approved = 0;
    const skipped: string[] = [];
    await this.mutate((b) => {
      const t = themeIn(b, themeId);
      for (const { personId, file } of shown) {
        if (isShownEdit(t, personId, file) && t.people.get(personId)!.pending!.planId === planId) {
          promote(t, personId, this.now());
          approved++;
        } else {
          skipped.push(personId);
        }
      }
      if (approved === 0) throw new PhotoThemeRefused("None of those edits is waiting for review as it was shown: look again", 409);
      for (const id of turnOn) b.plans.get(id)!.show = "themed";
    });
    if (skipped.length > 0) {
      console.log(`[photo-theme] approve all for plan ${scrub(planId)}: ${scrub(approved)} approved, ${scrub(skipped.length)} left for review (their edit changed since it was shown)`);
    }
    return { approved, skipped };
  }

  /**
   * The plans that should switch to Themed with this approval: those using the
   * theme, set to Original, with nobody on them showing a themed photo yet. The
   * first approval turns the switch on, and to Themed.
   */
  private async plansToTurnOn(themeId: string, planIds: string[]): Promise<string[]> {
    const theme = this.book.themes.get(themeId);
    const out: string[] = [];
    for (const planId of planIds) {
      const choice = this.book.plans.get(planId);
      if (!theme || choice?.themeId !== themeId || choice.show !== "original") continue;
      const read = await this.deps!.planPeople(choice.serviceTypeId, planId);
      // Not knowing who is on the plan is not knowing that nobody shows a
      // themed photo: the operator's Original stands.
      if (read.roster === "unavailable") continue;
      if (!read.people.some((p) => theme.people.get(p.personId)?.approved)) out.push(planId);
    }
    return out;
  }

  /** Keep an approved photo made from an older Planning Center photo. */
  async keep(themeId: string, personId: string): Promise<ThemePersonDTO> {
    const entry = this.entry(themeId, personId);
    if (!entry.approved) throw new PhotoThemeRefused("They have no approved photo in this theme", 409);
    const current = this.currentPhoto(personId);
    if (!current) throw new PhotoThemeRefused("Their current Planning Center photo is not known yet: open a plan they are on", 409);
    const fp = photoFingerprint(current);
    await this.mutate((b) => {
      const a = themeIn(b, themeId).people.get(personId)?.approved;
      if (a) a.acceptedFrom = fp;
    });
    return this.personDto(this.book.themes.get(themeId)!, personId, entry.name);
  }

  /** Move or copy a person's approved photo to another theme, replacing what they have there. */
  async transfer(themeId: string, personId: string, to: string, kind: "move" | "copy"): Promise<void> {
    if (to === themeId) throw new PhotoThemeRefused("That is the theme it is already in");
    const entry = this.entry(themeId, personId);
    themeIn(this.book, to);
    if (!entry.approved) throw new PhotoThemeRefused("They have no approved photo in this theme to " + kind, 409);
    if (kind === "move" && this.expected.has(jobKey(themeId, personId))) {
      throw new PhotoThemeRefused("Their photo in this theme is still being made", 409);
    }
    await this.mutate((b, _saved, afterSave) => {
      const from = themeIn(b, themeId);
      const target = themeIn(b, to);
      const src = from.people.get(personId);
      // Checked again here: a remove queued ahead of this write may have taken it.
      if (!src?.approved) throw new PhotoThemeRefused("They have no approved photo in this theme to " + kind, 409);
      afterSave(() => this.cancel(jobKey(to, personId)));
      // Put there on purpose: it stands for the target's prompt, not the one it was made under.
      target.people.set(personId, { personId, name: src.name, approved: { ...src.approved, prompt: promptKey(target.prompt) } });
      if (kind === "move") from.people.delete(personId);
    });
  }

  /** Take a person out of a theme: every plan using it shows their original again. */
  async remove(themeId: string, personId: string): Promise<void> {
    this.entry(themeId, personId);
    await this.mutate((b, _saved, afterSave) => {
      themeIn(b, themeId).people.delete(personId);
      afterSave(() => this.cancel(jobKey(themeId, personId)));
    });
  }

  private entry(themeId: string, personId: string): ThemePerson {
    const entry = themeIn(this.book, themeId).people.get(personId);
    if (!entry) throw new PhotoThemeRefused("That person has no photo in this theme", 404);
    return entry;
  }

  // ── Generating ──────────────────────────────────────────────────────────

  /**
   * Queue edits for the people on a plan. `missing` sends only those with no
   * approved photo in the theme and none waiting for review: anyone with an
   * approved one is reused at no cost. `all` (Redo all, after a prompt change)
   * also sends those on this plan whose photo was made under an earlier prompt.
   * Each photo records its own prompt, so people on other plans still made
   * under the old one keep the theme's `promptChanged` until they are redone too.
   */
  async generate(planId: string, serviceTypeId: string, mode: "missing" | "all"): Promise<GenerateResultDTO> {
    const usable = this.connection.usable();
    if (!usable.ok) throw new PhotoThemeRefused(usable.reason, 409);
    const choice = this.book.plans.get(planId);
    if (!choice?.themeId) throw new PhotoThemeRefused("Pick a theme for this plan first", 409);
    const themeId = choice.themeId;
    const read = await this.deps!.planPeople(serviceTypeId, planId);
    if (read.roster === "unavailable") throw rosterUnreadable(read);
    this.see(read.people);
    const theme = themeIn(this.book, themeId);
    const result: GenerateResultDTO = { queued: 0, reused: 0, skipped: [] };
    const toSend: PlanPerson[] = [];
    for (const p of read.people) {
      const what = this.wouldSend(theme, p, mode);
      if (what === "send") toSend.push(p);
      else if (what === "reused") result.reused++;
      else result.skipped.push({ personId: p.personId, name: p.name, reason: what.skip });
    }
    const runId = this.nextRunId++;
    const run: Run = { label: `plan ${planId}`, themeName: theme.name, made: 0, failed: 0, reused: result.reused, skipped: 0, outstanding: 0 };
    this.runs.set(runId, run);
    // Queued here, after every await: a second Generate that read the same
    // roster meanwhile finds these already queued and sends nobody twice.
    for (const p of toSend) {
      if (this.enqueue({ themeId, personId: p.personId, name: cleanName(p.name), sourceUrl: p.photoUrl!, planId, serviceDate: choice.sortDate, runId })) {
        result.queued++;
      } else {
        result.skipped.push({ personId: p.personId, name: p.name, reason: "Already being made" });
      }
    }
    run.skipped = result.skipped.length;
    run.outstanding = result.queued;
    if (result.queued === 0) this.finishRun(runId);
    this.changedNow();
    this.pump();
    return result;
  }

  /**
   * What a Generate in `mode` does with one person on the plan: send them, reuse
   * their approved photo, or skip them and why. The one rule: Generate applies it,
   * and the plan read counts it for the buttons, so a count is what a press sends.
   */
  private wouldSend(theme: Theme, p: PlanPerson, mode: "missing" | "all"): "send" | "reused" | { skip: string } {
    const entry = theme.people.get(p.personId);
    // Redo all sends again only a photo made under an earlier prompt.
    const keep = entry && !(mode === "all" && madeUnderEarlierPrompt(theme, entry));
    if (this.expected.has(jobKey(theme.id, p.personId))) return { skip: "Already being made" };
    // On screen already: reused at no cost, whatever a later Redo did. A failed Redo is tried again only by Redo.
    if (keep && entry.approved) return "reused";
    if (keep && entry.pending?.status === "ready") return { skip: "Made, waiting for review" };
    if (!p.photoUrl) return { skip: "No Planning Center photo" };
    if (!isAllowedPhotoUrl(p.photoUrl)) return { skip: "Their photo is not on Planning Center" };
    return "send";
  }

  /** Make one person's photo again. Their approved photo stays on screens until the new one is approved. */
  async redo(themeId: string, personId: string, from: { planId: string; serviceTypeId: string } | null): Promise<ThemePersonDTO> {
    const usable = this.connection.usable();
    if (!usable.ok) throw new PhotoThemeRefused(usable.reason, 409);
    const theme = themeIn(this.book, themeId);
    const key = jobKey(themeId, personId);
    if (this.expected.has(key)) throw new PhotoThemeRefused("Their photo is already being made", 409);
    let name = theme.people.get(personId)?.name;
    let sourceUrl: string | undefined;
    let serviceDate: string | null = null;
    if (from) {
      const read = await this.deps!.planPeople(from.serviceTypeId, from.planId);
      // Not knowing who is on the plan is not knowing they are off it: said as what it is.
      if (read.roster === "unavailable") throw rosterUnreadable(read);
      this.see(read.people);
      const p = read.people.find((x) => x.personId === personId);
      if (!p) throw new PhotoThemeRefused("That person is not on this plan", 404);
      name = p.name;
      sourceUrl = p.photoUrl ?? undefined;
      serviceDate = this.book.plans.get(from.planId)?.sortDate ?? null;
    } else {
      const entry = theme.people.get(personId);
      sourceUrl = this.currentPhoto(personId) ?? entry?.approved?.sourceUrl ?? entry?.pending?.sourceUrl;
    }
    if (!name) throw new PhotoThemeRefused("That person has no photo in this theme; redo them from a plan they are on", 404);
    if (!sourceUrl) throw new PhotoThemeRefused("They have no Planning Center photo", 409);
    if (!isAllowedPhotoUrl(sourceUrl)) throw new PhotoThemeRefused("Their photo is not on Planning Center", 409);
    name = cleanName(name);
    const runId = this.nextRunId++;
    // After the roster read: the check above can be passed by two Redos at once.
    if (!this.enqueue({ themeId, personId, name, sourceUrl, planId: from?.planId ?? null, serviceDate, runId })) {
      throw new PhotoThemeRefused("Their photo is already being made", 409);
    }
    this.runs.set(runId, { label: `${name}`, themeName: theme.name, made: 0, failed: 0, reused: 0, skipped: 0, outstanding: 1 });
    this.changedNow();
    this.pump();
    return this.personDto(theme, personId, name);
  }

  /**
   * Queue one edit, or refuse (false) when that person is already queued or
   * running in that theme. Synchronous, and the only place a job is queued: a
   * caller checks before its awaits, but only this check, made with nothing
   * awaited between it and the push, stops two requests paying for one photo.
   */
  private enqueue(j: Omit<Job, "id" | "key" | "attempts" | "notBefore">): boolean {
    const key = jobKey(j.themeId, j.personId);
    if (this.expected.has(key) || this.running.has(key) || this.queue.some((q) => q.key === key)) return false;
    const job: Job = { ...j, id: this.nextJobId++, key, attempts: 0, notBefore: 0 };
    this.expected.set(key, job.id);
    this.queue.push(job);
    return true;
  }

  /** Forget a queued or running job for this (theme, person). A running one's result is not kept. */
  private cancel(key: string): void {
    const id = this.expected.get(key);
    if (id === undefined) return;
    this.expected.delete(key);
    const queued = this.queue.find((j) => j.id === id);
    if (queued) {
      this.queue = this.queue.filter((j) => j.id !== id);
      this.settle(queued, null);
    }
  }

  private cancelTheme(themeId: string): void {
    for (const key of [...this.expected.keys()]) if (key.startsWith(`${themeId}\u0000`)) this.cancel(key);
  }

  /** Start what can start. */
  private pump(): void {
    if (this.paused || this.stopped) return;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    // The wall clock, not this.now(): a wait is a duration, and a test's
    // calendar clock (which dates the photos) stands still.
    const now = Date.now();
    if (now < this.holdUntil) {
      this.schedulePump(this.holdUntil - now);
      return;
    }
    while (this.running.size < MAX_RUNNING) {
      const i = this.queue.findIndex((j) => j.notBefore <= now);
      if (i === -1) break;
      const job = this.queue.splice(i, 1)[0]!;
      this.running.set(job.key, job);
      void this.run(job);
    }
    const waiting = this.queue.filter((j) => j.notBefore > now).map((j) => j.notBefore);
    if (waiting.length && this.running.size < MAX_RUNNING) this.schedulePump(Math.min(...waiting) - now);
  }

  private schedulePump(ms: number): void {
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, ms));
    this.pumpTimer.unref?.();
  }

  private async run(job: Job): Promise<void> {
    try {
      await this.attempt(job);
    } catch (err) {
      // Not swallowed: the job is failed with the reason and the line names it.
      await this.fail(job, `Could not be made: ${errorMessage(err)}`);
    } finally {
      this.running.delete(job.key);
      this.changedNow();
      this.pump();
    }
  }

  private async attempt(job: Job): Promise<void> {
    if (!this.book.themes.has(job.themeId) || this.expected.get(job.key) !== job.id) return this.settle(job, null);
    const usable = this.connection.usable();
    if (!usable.ok) return this.fail(job, usable.reason);
    const apiKey = await this.connection.apiKey();
    if (!apiKey) return this.fail(job, "OpenAI is not connected: add an API key in Integrations");
    const original = await (this.deps?.loadOriginal ?? defaultLoadOriginal)(job.sourceUrl);
    if (!original) return this.fail(job, "Could not read their Planning Center photo");
    let png: Buffer;
    try {
      png = await toPng(original);
    } catch (err) {
      // The image library's own words go to the log; the stored reason is ours.
      console.warn(`[photo-theme] the photo of ${scrub(job.name)} could not be decoded: ${scrub(errorMessage(err))}`);
      return this.fail(job, "Their Planning Center photo could not be read as an image");
    }
    // Checked again after the awaits, just before the request that bills: a person
    // removed, a theme deleted or a job cancelled while the original was read is
    // not sent. The prompt is the theme's as it stands now.
    const current = this.book.themes.get(job.themeId);
    if (!current || this.expected.get(job.key) !== job.id) return this.settle(job, null);
    job.prompt = current.prompt;
    const result = await editImage({ apiKey, prompt: job.prompt, png, fetchImpl: this.deps?.fetchImpl });
    if (result.ok) {
      this.connection.recordSuccess();
      const ext = editExtension(result.bytes);
      if (!ext) return this.fail(job, "OpenAI answered with something that is not an image");
      return this.commit(job, { status: "ready", bytes: result.bytes, ext });
    }
    if (result.kind === "rate-limited" && job.attempts < RATE_LIMIT_RETRIES) {
      const wait = Math.min(MAX_RETRY_MS, Math.max(1000, result.retryAfterMs ?? DEFAULT_RETRY_MS));
      job.attempts++;
      job.notBefore = Date.now() + wait;
      this.holdUntil = Math.max(this.holdUntil, job.notBefore);
      console.warn(`[photo-theme] rate limited by OpenAI; waiting ${scrub(Math.round(wait / 1000))} s before trying again (${scrub(job.attempts)} of ${scrub(RATE_LIMIT_RETRIES)})`);
      this.queue.unshift(job);
      return;
    }
    this.connection.recordFailure(result, "edit");
    await this.fail(job, result.reason);
    if (FATAL.has(result.kind)) {
      // The rest of the run would fail the same way, each one a request: failed
      // here, without asking. Taken off the queue all at once, before the first
      // await: another job's drain, or a pump from its finally, then finds
      // nothing left to fail twice or to send.
      const rest = this.queue;
      this.queue = [];
      for (const queued of rest) await this.fail(queued, result.reason);
    }
  }

  private async fail(job: Job, reason: string): Promise<void> {
    console.warn(`[photo-theme] ${scrub(job.name)} in "${scrub(this.book.themes.get(job.themeId)?.name ?? "a deleted theme")}" failed: ${scrub(reason)}`);
    await this.commit(job, { status: "failed", reason });
  }

  /** Record a finished job, if anything still wants it. */
  private async commit(job: Job, outcome: { status: "ready"; bytes: Buffer; ext: "webp" | "png" } | { status: "failed"; reason: string }): Promise<void> {
    if (this.expected.get(job.key) !== job.id) return this.notKept(job, outcome.status);
    if (this.paused) {
      console.warn(`[photo-theme] an edit of ${scrub(job.name)} finished while a restore was landing, and was not kept`);
      this.expected.delete(job.key);
      return this.settle(job, null);
    }
    let dropped = false;
    try {
      await this.mutate(async (b, saved) => {
        // Checked again in the write: a remove, move or copy, delete or sweep
        // queued ahead of this one cancels the job only once its own save has
        // landed, which can be after the check above.
        const t = b.themes.get(job.themeId);
        if (this.expected.get(job.key) !== job.id || !t) {
          dropped = true;
          return;
        }
        const at = new Date(this.now()).toISOString();
        const base = {
          madeFrom: photoFingerprint(job.sourceUrl),
          sourceUrl: job.sourceUrl,
          planId: job.planId,
          serviceDate: job.serviceDate,
          at,
          ...(job.prompt !== undefined ? { prompt: promptKey(job.prompt) } : {}),
        };
        const person = t.people.get(job.personId) ?? { personId: job.personId, name: job.name };
        person.name = job.name;
        if (outcome.status === "ready") {
          const file = await saveImageBytes(PHOTO_THEME_IMAGE_DIR, outcome.bytes, outcome.ext);
          saved.push(file);
          this.missing.delete(file);
          person.pending = { status: "ready", file, ...base };
        } else {
          person.pending = { status: "failed", reason: cleanReason(outcome.reason), ...base };
        }
        t.people.set(job.personId, person);
      });
    } catch (err) {
      // The book is as it was; the job is over either way. Said, never silent:
      // an operator would otherwise see a card spinning that will never land.
      console.error(`[photo-theme] could not record the result for ${scrub(job.name)}: ${scrub(errorMessage(err))}`);
      this.expected.delete(job.key);
      this.settle(job, false);
      return;
    }
    if (dropped) return this.notKept(job, outcome.status);
    this.expected.delete(job.key);
    this.settle(job, outcome.status === "ready");
  }

  /** A finished job nothing wants any more (removed, moved, deleted): said when it was a paid edit, and counted as skipped. */
  private notKept(job: Job, status: "ready" | "failed"): void {
    if (status === "ready") console.log(`[photo-theme] an edit of ${scrub(job.name)} finished after it was removed from its theme, and was not kept`);
    this.settle(job, null);
  }

  /** A job is over: count it into its run, and log the run when it is the last. */
  private settle(job: Job, made: boolean | null): void {
    const run = this.runs.get(job.runId);
    if (!run) return;
    if (made === true) run.made++;
    else if (made === false) run.failed++;
    else run.skipped++;
    run.outstanding--;
    if (run.outstanding <= 0) this.finishRun(job.runId);
  }

  private finishRun(runId: number): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    console.log(
      `[photo-theme] generate for ${scrub(run.label)} in "${scrub(run.themeName)}": ${scrub(run.made)} made, ${scrub(run.failed)} failed, ${scrub(run.reused)} reused at no cost, ${scrub(run.skipped)} skipped`,
    );
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  /**
   * Change the book. The change is made on a copy, saved, and only then becomes
   * the book: a failed save changes nothing and throws.
   *
   * `afterSave` holds what must happen only once the change is the book, such as
   * dropping a queued or running edit for a person it removed: a failed save
   * leaves the person, so their edit must still land. It runs in the same turn
   * of the write queue, so no job's commit queued behind can slip in between.
   */
  private async mutate(fn: (b: Book, saved: string[], afterSave: (then: () => void) => void) => void | Promise<void>): Promise<void> {
    await this.writes.enqueue(async () => {
      if (this.unusable) throw new PhotoThemeRefused(`Theme photos are off: ${this.unusable}`, 503);
      if (this.paused) throw new PhotoThemeRefused("A config restore is landing; try again in a moment", 503);
      const before = referencedFiles(this.book);
      const saved: string[] = [];
      const then: (() => void)[] = [];
      try {
        const next = cloneBook(this.book);
        await fn(next, saved, (f) => then.push(f));
        // Held to the rules a load applies before it is written: a value that
        // saved and was then refused at the next start would switch the whole
        // feature off. This way only the change that carried it fails.
        const file = serializeBook(next);
        parseBook(file);
        await store.save(file);
        this.book = next;
        this.shownCache.clear();
        for (const f of then) f();
      } finally {
        // Only what this change let go of (or saved and did not keep): never
        // "everything the book does not name", which on a book read empty
        // from a damaged file would be every photo there is.
        const after = referencedFiles(this.book);
        await this.removeFiles([...before, ...saved].filter((f) => !after.has(f)));
      }
    });
    this.changedNow();
    const sig = this.signature();
    if (sig !== this.shownSignature) {
      this.shownSignature = sig;
      this.deps?.onShownChanged();
    }
  }

  /** Every plan's shown photos, as one comparable string. */
  private signature(): string {
    return JSON.stringify([...this.book.plans.keys()].sort().map((id) => [id, [...this.shownPhotos(id)].sort()]));
  }

  /**
   * Remove stored edits a change let go of: a removed person, a deleted theme, a
   * redo that replaced a photo. Runs inside the write queue, so an edit is never
   * removed between being saved and being recorded. A file that will not go is
   * named and left where it is.
   */
  private async removeFiles(files: string[]): Promise<void> {
    for (const file of new Set(files)) {
      try {
        await fs.rm(path.join(imageDir(PHOTO_THEME_IMAGE_DIR), file), { force: true });
      } catch (err) {
        console.warn(`[photo-theme] could not remove the unused photo ${scrub(file)}: ${scrub(errorMessage(err))}; it is left in ${scrub(PHOTO_THEME_IMAGE_DIR)}/`);
      }
    }
  }

  private changedNow(): void {
    this.seq++;
    if (channelHasSubscribers(PHOTO_THEMES_CHANNEL)) broadcast(PHOTO_THEMES_CHANNEL, this.changed());
  }

  // ── Retention ───────────────────────────────────────────────────────────

  /**
   * Remove the photos of every theme past its keep date, and plan choices for
   * services past the same window. Dates are days in the app's time zone. A
   * theme a plan with no known date uses is left alone: there is no date to age
   * it by. Never runs over a file that could not be used.
   */
  async sweep(): Promise<{ photos: number; plans: number }> {
    if (this.paused) return { photos: 0, plans: 0 };
    if (this.unusable || store.refusingSaves() || store.loadedFromCorrupt) {
      console.warn("[photo-theme] retention sweep skipped: photo-themes.json is not usable");
      return { photos: 0, plans: 0 };
    }
    const today = zonedDateKey(this.now());
    const due = (b: Book) => {
      const expired: { id: string; name: string; until: string; photos: number }[] = [];
      for (const t of b.themes.values()) {
        if (t.people.size === 0) continue;
        const undated = [...b.plans.values()].some((p) => p.themeId === t.id && !p.sortDate);
        const until = keptUntil(t);
        if (!undated && today > until) expired.push({ id: t.id, name: t.name, until, photos: t.people.size });
      }
      const oldPlans = [...b.plans.values()].filter((p) => {
        const day = serviceDay(p.sortDate);
        return day !== null && today > addMonths(day, KEEP_MONTHS);
      });
      return { expired, oldPlans };
    };
    // A first look, to write nothing on the days nothing is due.
    const glance = due(this.book);
    if (glance.expired.length === 0 && glance.oldPlans.length === 0) return { photos: 0, plans: 0 };
    // Decided again inside the write, on the book as it is then: a theme chosen
    // for a later service while this waited its turn is no longer due.
    let found = glance;
    await this.mutate((b, _saved, afterSave) => {
      found = due(b);
      for (const e of found.expired) {
        b.themes.get(e.id)?.people.clear();
        afterSave(() => this.cancelTheme(e.id));
      }
      for (const p of found.oldPlans) b.plans.delete(p.planId);
    });
    const { expired, oldPlans } = found;
    for (const e of expired) {
      console.log(`[photo-theme] retention: removed ${scrub(e.photos)} photo(s) from "${scrub(e.name)}", kept until ${scrub(e.until)}`);
    }
    if (oldPlans.length > 0) console.log(`[photo-theme] retention: forgot the theme choice of ${scrub(oldPlans.length)} plan(s) more than ${scrub(KEEP_MONTHS)} months old`);
    return { photos: expired.reduce((n, e) => n + e.photos, 0), plans: oldPlans.length };
  }

  private startSweeps(): void {
    this.stopSweeps();
    const tick = () =>
      void this.sweep().catch((err: unknown) => console.error("[photo-theme] retention sweep failed:", scrubError(err)));
    this.sweepBootTimer = setTimeout(tick, 10_000);
    this.sweepBootTimer.unref?.();
    this.sweepTimer = setInterval(tick, 24 * 60 * 60 * 1000);
    this.sweepTimer.unref?.();
  }

  private stopSweeps(): void {
    if (this.sweepBootTimer) clearTimeout(this.sweepBootTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepBootTimer = null;
    this.sweepTimer = null;
  }

  /** Tests: wait until nothing is queued, running or being written. */
  async idle(): Promise<void> {
    for (;;) {
      await this.writes.enqueue(async () => undefined);
      if (this.running.size === 0 && this.queue.length === 0) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Tests: start again from the file. */
  async reloadForTests(): Promise<void> {
    await store.reload();
    this.resetState();
    if (this.deps) await this.start(this.deps, { sweep: false });
  }
}

/** A plan whose roster could not be read: a 502 naming why, never "not on this plan". */
function rosterUnreadable(read: PlanPeopleRead): PhotoThemeRefused {
  return new PhotoThemeRefused(`Could not read who is on this plan: ${read.reason ?? "Planning Center did not answer"}`, 502);
}

function themeIn(b: Book, id: string): Theme {
  const t = b.themes.get(id);
  if (!t) throw new PhotoThemeRefused("There is no theme with that id", 404);
  return t;
}

/** A ready edit becomes the approved photo. */
function promote(t: Theme, personId: string, now: number): void {
  const p = t.people.get(personId);
  if (!p?.pending || p.pending.status !== "ready" || !p.pending.file) return;
  const { file, madeFrom, sourceUrl, planId, serviceDate, prompt } = p.pending;
  p.approved = { file, madeFrom, sourceUrl, planId, serviceDate, approvedAt: new Date(now).toISOString(), ...(prompt !== undefined ? { prompt } : {}) };
  delete p.pending;
}

/** The person's edit waiting for review is still the file the operator was shown. */
function isShownEdit(t: Theme, personId: string, file: string): boolean {
  const pending = t.people.get(personId)?.pending;
  return pending?.status === "ready" && pending.file === file;
}

function choiceDto(c: PlanChoice): PlanChoiceDTO {
  return { planId: c.planId, serviceTypeId: c.serviceTypeId, sortDate: c.sortDate, themeId: c.themeId, show: c.show };
}

function noneDto(personId: string, name: string): ThemePersonDTO {
  return { personId, name, status: "none", promptChanged: false, approved: null, pending: null, originalUrl: null };
}

export const photoThemes = new PhotoThemesService();
