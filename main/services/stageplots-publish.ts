// stageplots-publish.ts — a venue's stage plots on the public page, behind a secret link.
//
// Through the same page, address, token and HTTP client as ServiceCue on the web
// (servicecue-publish-client.ts), under the StagePlots keys of the contract
// (main/types/servicecue-publish.ts): per venue, every background its plots draw, one doc
// per plot and an index, all under the venue's own secret. See docs/features/stageplots.md.
//
// THE ONE RULE: no secret is ever live on a page that the store does not know of. A new secret
// is written to the store's pending removals before its first request goes out, and moves onto
// its venue only once the page has it all; anything that would forget a secret (a regenerate, an
// unpublish or delete the page cannot hear, a take-back that fails, a move to another page)
// queues it there instead. The publisher drains that list whenever it can reach the page: at
// start, on Publish now and Remove now, on every change, and when a page is set up again.
//
//   Publish        a new secret; backgrounds, then plots, then the index, which is what makes
//                  the link a page. A background the page refuses is listed as not yet
//                  published and the plot is drawn without it; anything else that fails
//                  leaves the venue unpublished and takes back what went up.
//   Regenerate     the same under a new secret, every background the old link has included,
//                  and only then the old secret is queued for removal and removed.
//   Unpublish      drops the venue's secret on its page. With no page to reach (none set up, or
//                  the venue on another), it is queued for removal and the venue is unpublished.
//                  A page that refuses the drop leaves the venue published, and says so.
//   Publish now    everything again, every background included, and the queue drained. A venue
//                  on a page other than the one set up moves to it under a new secret.
//   A change       to the document, or to the plan it follows: each published venue is sent
//                  what changed, after a short wait, one run at a time per venue. A change that
//                  alters nothing published (the publish state this writes, say) sends nothing.
//
// THE SECRET IS NEVER LOGGED, never in an error sent back, never in a stored error: every
// sentence goes through `say` or `errorAt`, which hide it. It is in the store, which a LAN
// browser reads to show the link (pending ones never leave the server), and in config backups
// (see the restore rule in stageplots-doc.ts).

import { randomBytes } from "node:crypto";

import { errorMessage } from "./errors.js";
import { plural } from "./plural.js";
import { scrub } from "./scrub.js";
import { createPushClient, type PushClient, type PushFailure, type PushResult } from "./servicecue-publish-client.js";
import { docHash } from "./servicecue-publish-docs.js";
import type { PublishOrigin } from "./servicecue-publish-rules.js";
import { resolvePlot } from "./stageplots-doc.js";
import {
  PUBLISH_MAX_BODY_BYTES,
  STAGEPLOTS_IMAGE_TYPE,
  STAGEPLOTS_INDEX_KEY,
  stagePlotsImageKey,
  stagePlotsPlotKey,
} from "../types/servicecue-publish.js";
import { STAGEPLOT_LIMITS, type Background, type PendingReason, type PendingRemoval, type Plot, type PublishedPlot, type PublishedVenue, type StagePlotsDoc, type Venue, type VenuePublish } from "../types/stageplots.js";

/** A new secret: 32 random bytes, base64url, 43 characters. Made here and nowhere else. */
export function newPublishSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Where to publish: the ServiceCue page's address and token, or why there is none. */
export type PublishTarget = { ok: true; origin: PublishOrigin; token: string } | { ok: false; message: string };

export interface StagePlotsStoreLike {
  get(): Promise<StagePlotsDoc>;
  update(fn: (doc: StagePlotsDoc) => StagePlotsDoc): Promise<StagePlotsDoc>;
}

export interface StagePlotsPublishDeps {
  target(): Promise<PublishTarget>;
  store: StagePlotsStoreLike;
  /** A converted background's WebP bytes, by hash, or null when the file is not there. */
  image(hash: string): Promise<Uint8Array | null>;
  /** The plan the app follows (live or next), or nulls with none or no Planning Center. */
  plan(): { planId: string | null; planDates: string | null };
  /** The zone the page shows dates in: the app's. */
  timeZone(): string;
  /** Told after every write of a venue's publish state: the routes broadcast it. */
  onSaved(doc: StagePlotsDoc): void;
  /** Registers the callback the app's broadcaster calls for every channel. */
  listen?: (cb: (channel: string) => void) => void;
  /** The client for a target. A seam for a test; the app's is the ServiceCue publisher's. */
  client?: (target: { origin: PublishOrigin; token: string }) => PushClient;
  /** How long a change waits for more before it is published. */
  debounceMs?: number;
  now?: () => number;
}

/** What an action answered: the venue as it now is, or why not, with the status to answer it with. */
export type PublishOutcome = { ok: true; venue: Venue; notice?: string } | { ok: false; status: 400 | 404 | 409 | 502 | 503; error: string };

/** The answer to anything that would write while a config restore is landing. */
type Restoring = { ok: false; status: 503; error: string };
const RESTORING: Restoring = { ok: false, status: 503, error: "A config restore is under way; try again once the server is back." };

/** What is said when a link is left on a page this server cannot reach now. */
function leftOn(host: string): string {
  return `The link is left on ${host} until that page is set up here again; then it is removed.`;
}

/** The host of an origin, for every sentence that names a page. */
const hostOf = (origin: string) => new URL(origin).host;

/** How long a change waits for the next before it is published. */
export const REPUBLISH_WAIT_MS = 2000;

const MB = 1_000_000;
const mb = (bytes: number) => (bytes / MB).toFixed(1);

type Level = "log" | "warn" | "error";

/** The longest last-error sentence the store keeps (stageplots-store.ts). */
const ERROR_CHARS = 600;

/**
 * `message` as it may leave this file, logged, stored or sent back: every secret in it hidden,
 * and cut to what the store keeps, so a long failure can never make the save of the publish it
 * describes throw. Everything said, stored and answered goes through it.
 */
function hide(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const s of secrets) if (s) text = text.split(s).join("<secret>");
  return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS - 1)}…` : text;
}

/** Every [stageplots] line this file writes: hidden, then scrubbed, so no line can carry a
 *  secret or forge another line whatever went into it. Guarded by behaviour in
 *  stageplots-publish.test.ts ("the log"): the source scan cannot see a console[level] call. */
function say(level: Level, secrets: readonly string[], message: string): void {
  console[level](`[stageplots] ${scrub(hide(message, secrets), ERROR_CHARS)}`);
}

/** A venue's last error, as hide() makes it. */
function errorAt(at: string, message: string, secrets: readonly string[]): { at: string; message: string } {
  return { at, message: hide(message, secrets) };
}

// ── What is published ────────────────────────────────────────────────────────

/** The converted backgrounds a venue's plots draw, by hash, sorted. */
export function venueImages(doc: StagePlotsDoc, venue: Venue): string[] {
  const byId = new Map(doc.backgrounds.map((b) => [b.id, b]));
  const hashes = new Set<string>();
  for (const plot of plotsOf(doc, venue)) {
    const bg = plot.backgroundId ? byId.get(plot.backgroundId) : undefined;
    if (bg) hashes.add(bg.converted.hash);
  }
  return [...hashes].sort();
}

function plotsOf(doc: StagePlotsDoc, venue: Venue): Plot[] {
  const byId = new Map(doc.plots.map((p) => [p.id, p]));
  return venue.plotIds.map((id) => byId.get(id)).filter((p): p is Plot => p !== undefined);
}

/** One plot as the page gets it. The background's hash only once the page holds the image: a plot never names one it would draw broken. */
export function publishedPlot(plot: Plot, background: Background | null, held: boolean): PublishedPlot {
  return {
    id: plot.id,
    name: plot.name,
    bgFade: plot.bgFade,
    items: plot.items,
    background: background ? { hash: held ? background.converted.hash : null, width: background.converted.width, height: background.converted.height } : null,
  };
}

/** A venue's index as the page gets it: what it shows for the followed plan, at this moment. */
export function publishedVenue(doc: StagePlotsDoc, venue: Venue, plan: { planId: string | null; planDates: string | null }, timeZone: string): PublishedVenue {
  const shown = resolvePlot(doc, venue.id, plan.planId);
  const override = shown.reason === "plan" ? doc.overrides.find((o) => o.planId === plan.planId && o.venueId === venue.id) : undefined;
  return {
    name: venue.name,
    notes: venue.notes,
    plots: plotsOf(doc, venue).map((p) => ({ id: p.id, name: p.name })),
    defaultPlotId: venue.defaultPlotId,
    shown: { plotId: shown.plot?.id ?? null, reason: shown.reason },
    plan: shown.reason === "plan" ? { date: override?.planDate ?? null, dates: plan.planDates } : null,
    timeZone,
  };
}

/** The sentence a failure is said as on the card, the log and the answer. */
function sentence(f: PushFailure, host: string): string {
  // Every well-formed StagePlots request the Worker knows is answered something other than 404.
  if (f.kind === "refused" && f.status === 404) return `${host} does not know StagePlots yet: deploy the Worker.`;
  const timeout = /^No answer from .+ within (\d+) seconds\.$/.exec(f.message);
  if (f.kind === "unreachable" && timeout) return `${host} did not answer (timed out after ${timeout[1]} s).`;
  if (f.kind === "unreachable") return `${host} could not be reached: ${f.message.replace(/\.$/, "")}.`;
  return /[.!?]$/.test(f.message) ? f.message : `${f.message}.`;
}

/** A failure that is about the page, not the one thing sent: nothing more is worth sending. */
const aboutThePage = (f: PushFailure) => f.kind !== "refused" || f.status === 404;

type SendResult =
  | { ok: true; sent: number; held: string[]; unpublished: { hash: string; why: string }[]; warnings: string[] }
  /** `sent`: how many requests went out before it failed, so a caller knows whether there is anything to take back. */
  | { ok: false; status: 400 | 502; message: string; sent: number };

interface SendOptions {
  /** Send every doc, every background and the keep list, whatever this process last sent. */
  force: boolean;
  /** Backgrounds that must go through, or the whole send fails: what the old link held (regenerate). */
  required: readonly string[];
  /** The backgrounds the page holds under this secret already. */
  held: readonly string[];
}

type Sent = Extract<SendResult, { ok: true }>;
type Target = { origin: PublishOrigin; token: string };

/** The chain the queue of pending removals is drained on, beside the venues' own. */
const PENDING_CHAIN = "\u0000pending";

/** What a drain answers: the queue after it, how many went, and the page it drained against; or why it could not. */
type Drained = { ok: true; left: PendingRemoval[]; removed: number; page: string | null } | { ok: false; message: string };

/** Said when stageplots.json's pending removals are not a list (stageplots-store.ts leaves them so). */
const DAMAGED_QUEUE = "stageplots.json's pending removals are not a list, so the old links waiting to be removed cannot be read.";

/** The chain a saved page address is handled on. */
const ADDRESS_CHAIN = "\u0000address";

// ── The publisher ────────────────────────────────────────────────────────────

export class StagePlotsPublisher {
  private readonly deps: StagePlotsPublishDeps;
  private readonly waitMs: number;
  /** Per venue (and the queue), the run in progress: each waits for the one before. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Per secret, the hash of each key's text as last sent, so a republish sends only what changed. */
  private readonly sent = new Map<string, Map<string, string>>();
  /** Per secret, the keys last kept. */
  private readonly kept = new Map<string, string>();
  /** Per venue, what the last republish was built from, sent or not: the same again is not tried again. */
  private readonly attempted = new Map<string, string>();
  /** Pending removals whose failure has been said: said once, not on every change. */
  private readonly saidStuck = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Resolved once the pending wait has fired and its republish has finished, or the wait is cancelled. */
  private timerDone: Promise<void> = Promise.resolve();
  /** Resolves timerDone: called when the wait's republish finishes, or by cancelWait. */
  private fireTimer: (() => void) | null = null;
  private planKey: string | null = null;
  private started = false;
  private stopped = false;
  private paused = false;

  constructor(deps: StagePlotsPublishDeps) {
    this.deps = deps;
    this.waitMs = deps.debounceMs ?? REPUBLISH_WAIT_MS;
  }

  /** Listen for changes, and drain what is queued (a crash may have left a publish in flight). Once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.planKey = this.currentPlanKey();
    this.deps.listen?.((channel) => this.heard(channel));
    void this.drainQueued(true);
  }

  /** Shutdown: no more republishing, and whatever is running finishes. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelWait();
    await Promise.all([...this.chains.values()]);
  }

  /**
   * For a config restore: wait for every run in flight, then refuse every action and skip every
   * republish and drain until the answer is called, so nothing here writes over the restored
   * file. A restore that succeeds never calls it (the process restarts).
   */
  async pause(): Promise<() => void> {
    this.paused = true;
    this.cancelWait();
    await Promise.all([...this.chains.values()]);
    return () => {
      this.paused = false;
    };
  }

  /** Every pending wait has fired and every run it queued has finished. For tests and the drive. */
  async settle(): Promise<void> {
    for (;;) {
      await this.timerDone;
      await Promise.all([...this.chains.values()]);
      if (this.timer === null && this.chains.size === 0) return;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private client(target: Target): PushClient {
    return (this.deps.client ?? ((t) => createPushClient(t)))(target);
  }

  private currentPlanKey(): string {
    const p = this.deps.plan();
    return JSON.stringify([p.planId, p.planDates]);
  }

  private heard(channel: string): void {
    if (this.stopped || this.paused) return;
    if (channel === "stageplots:updated") return this.changed();
    // The state is broadcast often; only the plan it follows moving is a change to what is published.
    if (channel === "stage:state-changed") {
      const key = this.currentPlanKey();
      if (key === this.planKey) return;
      this.planKey = key;
      this.changed();
    }
  }

  /** Something published may have changed: republish each published venue after the wait. */
  changed(): void {
    if (this.stopped || this.paused) return;
    this.cancelWait();
    let fire!: () => void;
    this.timerDone = new Promise((resolve) => (fire = resolve));
    this.fireTimer = fire;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fireTimer = null;
      void this.republishAll().finally(fire);
    }, this.waitMs);
    this.timer.unref?.();
  }

  /**
   * Drop the pending wait, and resolve what settle() is awaiting on it: a wait cleared and never
   * resolved leaves settle() waiting for ever (and every test or drive that settles, with it).
   */
  private cancelWait(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.fireTimer?.();
    this.fireTimer = null;
  }

  private async republishAll(): Promise<void> {
    let doc: StagePlotsDoc;
    try {
      doc = await this.deps.store.get();
    } catch (err) {
      say("error", [], `could not read the stage plots to republish them: ${errorMessage(err)}`);
      return;
    }
    for (const venue of doc.venues) {
      const pub = venue.publish;
      if (!pub) continue;
      // Nobody is waiting on a republish: what throws in one (the settings or the store
      // unreadable) is said here, or it is never said at all.
      void this.serial(venue.id, () => this.republish(venue.id)).catch((err: unknown) => {
        say("error", [pub.secret], `"${venue.name}" could not be republished: ${errorMessage(err)}`);
      });
    }
    if (!Array.isArray(doc.pendingRemovals) || doc.pendingRemovals.length > 0) void this.drainQueued(false);
  }

  /** Run `fn` after whatever `key` (a venue, or the queue) is already running. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** An action, on the venue's chain, refused while a restore is landing. */
  private action<T>(venueId: string, fn: () => Promise<T>): Promise<T | Restoring> {
    if (this.paused) return Promise.resolve(RESTORING);
    return this.serial<T | Restoring>(venueId, () => (this.paused ? Promise.resolve(RESTORING) : fn()));
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  publish(venueId: string): Promise<PublishOutcome> {
    return this.action(venueId, async () => {
      const found = await this.venueAndTarget(venueId, false, "Publish");
      if (!found.ok) return found;
      const { doc, venue, target, client, host } = found;
      const queueFull = this.queueFull(doc, "Publish", venue.name);
      if (queueFull) return queueFull;
      const fresh = await this.sendFresh(client, target, doc, venue, []);
      if (!fresh.ok) {
        say("warn", [fresh.secret], `"${venue.name}" was not published: ${fresh.message}`);
        return { ok: false, status: fresh.status, error: hide(fresh.message, [fresh.secret]) };
      }
      const { secret, r } = fresh;
      const at = this.at();
      const saved = await this.promote(venueId, secret, target.origin, stateAfterSend(secret, target.origin, at, r, [secret]), null);
      if (!saved) {
        // Deleted while it was being published: the secret is still queued, so take it back now.
        await this.takeBack(client, secret, target.origin, venue.name);
        return { ok: false, status: 404, error: "no such venue" };
      }
      this.attempted.set(venueId, this.fingerprint(doc, venue));
      say("log", [secret], `"${venue.name}" published to ${host}: ${plural(plotsOf(doc, venue).length, "plot")} and ${plural(r.held.length, "background")}${missingNote(r)}`);
      return { ok: true, venue: saved };
    });
  }

  regenerate(venueId: string): Promise<PublishOutcome> {
    return this.action(venueId, async () => {
      const found = await this.venueAndTarget(venueId, true, "Regenerate");
      if (!found.ok) return found;
      const { doc, venue, target, client, host } = found;
      const pub = venue.publish!;
      // Checked before anything is sent: a regenerate queues the old link, and must not be the one
      // that cannot.
      const queueFull = this.queueFull(doc, "Regenerate", venue.name);
      if (queueFull) return queueFull;
      const fresh = await this.sendFresh(client, target, doc, venue, pub.publishedImages);
      const all = [fresh.secret, pub.secret];
      if (!fresh.ok) {
        const message = `The link was not changed: ${fresh.message}`;
        say("warn", all, `"${venue.name}": ${message}`);
        const at = this.at();
        await this.savePublish(venueId, (p) => ({ ...p, lastError: errorAt(at, message, all) }));
        return { ok: false, status: fresh.status, error: hide(message, all) };
      }
      const { secret, r } = fresh;
      const at = this.at();
      // One write: the new link onto the venue and the old one into the queue, so a crash after it
      // leaves the old secret queued for removal rather than nowhere.
      const saved = await this.promote(venueId, secret, target.origin, stateAfterSend(secret, target.origin, at, r, all), { secret: pub.secret, origin: pub.origin, since: at, reason: "regenerated" });
      if (!saved) {
        await this.takeBack(client, secret, target.origin, venue.name);
        return { ok: false, status: 404, error: "no such venue" };
      }
      this.attempted.set(venueId, this.fingerprint(doc, venue));
      const drained = await this.drainQueued(false);
      const old = !drained.ok
        ? `the old one stays queued: ${drained.message}`
        : !drained.left.some((e) => e.secret === pub.secret)
          ? "the old one is removed"
          : pub.origin === target.origin
            ? "the old one could not be removed yet and stays queued"
            : `the old one stays queued: ${leftOn(hostOf(pub.origin))}`;
      say("log", all, `"${venue.name}" has a new link on ${host}; ${old}`);
      return { ok: true, venue: (await this.venueNow(venueId)) ?? saved };
    });
  }

  unpublish(venueId: string): Promise<PublishOutcome> {
    return this.action(venueId, async () => {
      const doc = await this.deps.store.get();
      const venue = doc.venues.find((v) => v.id === venueId);
      if (!venue?.publish) return this.refused("Unpublish", venueId, venue ?? null, venue ? 409 : 404, venue ? `${venue.name} is not published` : "no such venue");
      const pub = venue.publish;
      const target = await this.deps.target();
      // The page can be asked: it must say yes, or nothing changes and the card says the link works.
      if (target.ok && target.origin === pub.origin) {
        const host = hostOf(target.origin);
        const r = await this.client(target).dropStagePlots(pub.secret);
        if (!r.ok) {
          const message = `${sentence(r, host)} Nothing was unpublished, so the link still works.`;
          say("warn", [pub.secret], `"${venue.name}" could not be unpublished: ${message}`);
          const at = this.at();
          await this.savePublish(venueId, (p) => ({ ...p, lastError: errorAt(at, message, [pub.secret]) }));
          return { ok: false, status: 502, error: hide(message, [pub.secret]) };
        }
        this.forget(pub.secret);
        const after = await this.unpublishInStore(venueId, null);
        say("log", [pub.secret], `"${venue.name}" unpublished: its link and backgrounds are removed from ${host}`);
        return after ? { ok: true, venue: after } : { ok: false, status: 404, error: "no such venue" };
      }
      // No page set up, or the venue is on another: it cannot be asked, so the secret is queued and
      // the venue unpublished. The operator sees what is left, and it goes once the page is set up.
      const after = await this.unpublishInStore(venueId, { secret: pub.secret, origin: pub.origin, since: this.at(), reason: "unpublished" });
      const notice = leftOn(hostOf(pub.origin));
      say("warn", [pub.secret], `"${venue.name}" unpublished here; ${notice}`);
      return after ? { ok: true, venue: after, notice } : { ok: false, status: 404, error: "no such venue" };
    });
  }

  /**
   * Before a venue is deleted: unpublish it, and queue its secret when the page does not take
   * the drop, since nothing would be left to remove it. The answer's notice is for the operator.
   */
  retireForDelete(venueId: string): Promise<{ ok: true; notice?: string } | Restoring> {
    return this.action(venueId, async (): Promise<{ ok: true; notice?: string }> => {
      const doc = await this.deps.store.get();
      const venue = doc.venues.find((v) => v.id === venueId);
      const pub = venue?.publish;
      if (!venue || !pub) return { ok: true };
      const target = await this.deps.target();
      if (target.ok && target.origin === pub.origin) {
        const r = await this.client(target).dropStagePlots(pub.secret);
        if (r.ok) {
          this.forget(pub.secret);
          await this.unpublishInStore(venueId, null);
          say("log", [pub.secret], `"${venue.name}" is being deleted: its link and backgrounds are removed from ${hostOf(pub.origin)}`);
          return { ok: true };
        }
        say("warn", [pub.secret], `"${venue.name}" is being deleted and its link could not be removed: ${sentence(r, hostOf(pub.origin))} It is queued for removal.`);
      }
      await this.unpublishInStore(venueId, { secret: pub.secret, origin: pub.origin, since: this.at(), reason: "venue deleted" });
      const notice = target.ok && target.origin === pub.origin ? `The link could not be removed from ${hostOf(pub.origin)} yet; it is tried again until it goes.` : leftOn(hostOf(pub.origin));
      say("warn", [pub.secret], `"${venue.name}" is being deleted; ${notice}`);
      return { ok: true, notice };
    });
  }

  publishNow(venueId: string): Promise<PublishOutcome> {
    return this.action(venueId, async () => {
      const found = await this.venueAndTarget(venueId, true, "Publish now");
      if (!found.ok) return found;
      const { doc, venue, target, client, host } = found;
      const pub = venue.publish!;
      await this.drainQueued(false);
      if (pub.origin !== target.origin) return this.move(venue, doc, target, "Publish now");
      const r = await this.sendVenue(client, host, pub.secret, doc, venue, { force: true, required: [], held: [] });
      this.attempted.set(venueId, this.fingerprint(doc, venue));
      return this.finish(venueId, venue, r, host, [pub.secret], "published again");
    });
  }

  /** Remove now: drain the queue against the page set up. Answers what is left of it, or why it could not be read. */
  async removePending(): Promise<{ removed: number; left: number; waiting: number } | { error: string; status: 503 }> {
    if (this.paused) return RESTORING;
    const drained = await this.drainQueued(false);
    if (!drained.ok) return { status: 503, error: drained.message };
    const waiting = drained.left.filter((e) => e.origin !== drained.page).length;
    return { removed: drained.removed, left: drained.left.length - waiting, waiting };
  }

  /** A change: send what differs from what was last sent. Nothing at all when nothing published changed. */
  private async republish(venueId: string): Promise<void> {
    if (this.paused) return;
    let doc: StagePlotsDoc;
    try {
      doc = await this.deps.store.get();
    } catch (err) {
      say("error", [], `could not read the stage plots to republish them: ${errorMessage(err)}`);
      return;
    }
    const venue = doc.venues.find((v) => v.id === venueId);
    const pub = venue?.publish;
    if (!venue || !pub) return;
    const print = this.fingerprint(doc, venue);
    if (this.attempted.get(venueId) === print) return;
    this.attempted.set(venueId, print);
    const target = await this.deps.target();
    if (!target.ok) {
      say("warn", [pub.secret], `"${venue.name}" changed and could not be republished: ${target.message}`);
      const at = this.at();
      await this.savePublish(venueId, (p) => ({ ...p, lastError: errorAt(at, target.message, [pub.secret]) }));
      return;
    }
    if (pub.origin !== target.origin) {
      await this.move(venue, doc, target, "A change");
      return;
    }
    const host = hostOf(target.origin);
    const r = await this.sendVenue(this.client(target), host, pub.secret, doc, venue, { force: false, required: [], held: pub.publishedImages });
    if (r.ok && r.sent === 0 && sameList(r.held, pub.publishedImages) && sameList(r.unpublished.map((u) => u.hash).sort(), pub.unpublishedImages) && r.warnings.length === 0) {
      return;
    }
    await this.finish(venueId, venue, r, host, [pub.secret], "republished");
  }

  /**
   * A venue published to a page other than the one set up: publish it there under a new secret,
   * and queue the old one against its own page, where only that page's token can remove it. A
   * new link because the address changes anyway, and so one secret never lives on two pages.
   * When the new page will not take it, the venue stays where it was and says why.
   */
  private async move(venue: Venue, doc: StagePlotsDoc, target: Target, why: string): Promise<PublishOutcome> {
    const pub = venue.publish!;
    const host = hostOf(target.origin);
    const fresh = await this.sendFresh(this.client(target), target, doc, venue, []);
    const all = [fresh.secret, pub.secret];
    if (!fresh.ok) {
      const message = `Not moved to ${host}: ${fresh.message} The link on ${hostOf(pub.origin)} stays as it is.`;
      say("warn", all, `"${venue.name}" (${why}): ${message}`);
      const at = this.at();
      await this.savePublish(venue.id, (p) => ({ ...p, lastError: errorAt(at, message, all) }));
      return { ok: false, status: fresh.status, error: hide(message, all) };
    }
    const at = this.at();
    const saved = await this.promote(venue.id, fresh.secret, target.origin, stateAfterSend(fresh.secret, target.origin, at, fresh.r, all), {
      secret: pub.secret,
      origin: pub.origin,
      since: at,
      reason: "address changed",
    });
    if (!saved) {
      // Deleted while it was being moved: the new secret is still queued, so take it back now.
      await this.takeBack(this.client(target), fresh.secret, target.origin, venue.name);
      return { ok: false, status: 404, error: "no such venue" };
    }
    this.attempted.set(venue.id, this.fingerprint(doc, venue));
    say("log", all, `"${venue.name}" moved to ${host} under a new link (${why}); its old link on ${hostOf(pub.origin)} is queued for removal`);
    return { ok: true, venue: saved };
  }

  /**
   * The Public link was saved. `old` is the page it was set up for before, with its token read
   * before the save replaced it (null when there was none); `saved` the address the save left
   * set up (its origin), or null when it cleared it. When the address changed, every venue on the
   * old page moves to the new one; with no new page to move to (no token for it, or no address),
   * every venue on the old page is taken down instead, since nothing here could reach it after
   * this request. Then, while the old token is still in hand, everything queued against the old
   * page (the moved venues' old links among it) is removed with it; what will not go stays
   * queued, against the old page. Then the queue is drained for the page set up now, which a new
   * token may have just made reachable.
   *
   * In the background, since a move uploads every background, and on a chain of its own, so
   * settle() and stop() cover it. Never rejects: each step's failure is said on [stageplots] and
   * left on the card, as the last error of each venue it concerns, and never stops the drain
   * with the old token.
   */
  pageSaved(old: Target | null, saved: string | null): Promise<void> {
    return this.serial(ADDRESS_CHAIN, () => this.afterPageSaved(old, saved));
  }

  private async afterPageSaved(old: Target | null, saved: string | null): Promise<void> {
    if (this.paused) return;
    const away = old !== null && old.origin !== saved;
    let target: PublishTarget | null = null;
    try {
      target = await this.deps.target();
    } catch (err) {
      await this.followFailed(old, `the page settings could not be read: ${errorMessage(err)}`);
    }
    if (target?.ok && (old === null || away)) await this.moveAll(target, old);
    // The address changed (or was cleared) with no token for the new one: after this request
    // nothing here can reach the old page, so its links come down now, with its token.
    else if (target && !target.ok && away) await this.takeDownOldPage(old!);
    if (away) await this.drainQueued(false, old!);
    if (target?.ok) await this.drainQueued(false);
  }

  /** The venues on any page but `target`'s, each moved to it on its own chain. */
  private async moveAll(target: Target, old: Target | null): Promise<void> {
    let venues: Venue[];
    try {
      venues = (await this.deps.store.get()).venues;
    } catch (err) {
      return this.followFailed(old, `the stage plots could not be read: ${errorMessage(err)}`);
    }
    for (const venue of venues) {
      if (!venue.publish || venue.publish.origin === target.origin) continue;
      await this.serial(venue.id, async () => {
        const now = await this.venueNow(venue.id);
        if (now?.publish && now.publish.origin !== target.origin) await this.move(now, await this.deps.store.get(), target, "the page address changed");
      }).catch((err: unknown) => this.venueFailed(venue, `Not moved to ${hostOf(target.origin)}: ${errorMessage(err)}`));
    }
  }

  /**
   * The page this server leaves, with no new page to move to: every venue on it unpublished, its
   * link dropped with the old token, or queued against the old page when the drop fails, so the
   * card shows it rather than a venue claiming a link nothing here can reach.
   */
  private async takeDownOldPage(old: Target): Promise<void> {
    const host = hostOf(old.origin);
    let venues: Venue[];
    try {
      venues = (await this.deps.store.get()).venues;
    } catch (err) {
      return this.followFailed(old, `the stage plots could not be read: ${errorMessage(err)}`);
    }
    for (const venue of venues) {
      if (venue.publish?.origin !== old.origin) continue;
      await this.serial(venue.id, async () => {
        const pub = (await this.venueNow(venue.id))?.publish;
        if (!pub || pub.origin !== old.origin) return;
        const r = await this.client(old).dropStagePlots(pub.secret);
        if (r.ok) {
          this.forget(pub.secret);
          await this.unpublishInStore(venue.id, null);
          // A warning, not a note: nobody pressed Unpublish.
          say("warn", [pub.secret], `"${venue.name}" unpublished: the page address changed with no page to move to, so its link and backgrounds are removed from ${host}`);
          return;
        }
        await this.unpublishInStore(venue.id, { secret: pub.secret, origin: pub.origin, since: this.at(), reason: "address changed" });
        say("warn", [pub.secret], `"${venue.name}" unpublished: the page address changed with no page to move to, and its link could not be removed from ${host} (${sentence(r, host)}); it is queued for removal`);
      }).catch((err: unknown) => this.venueFailed(venue, `The page address changed, and taking its link down from ${host} failed part way: ${errorMessage(err)}`));
    }
  }

  /** A step of following the page address failed for every venue: said, and on each venue on the old page (every published one with none). */
  private async followFailed(old: Target | null, why: string): Promise<void> {
    const message = `The page address was saved, but the published stage plots could not follow it: ${why}`;
    say("error", [], message);
    let venues: Venue[];
    try {
      venues = (await this.deps.store.get()).venues;
    } catch {
      // The store cannot be read: GET /api/stageplots answers that, which the card shows.
      return;
    }
    for (const venue of venues) if (venue.publish && (!old || venue.publish.origin === old.origin)) await this.venueFailed(venue, message);
  }

  /** A step of following the page address failed for one venue: said, and left as its last error. */
  private async venueFailed(venue: Venue, message: string): Promise<void> {
    const secrets = venue.publish ? [venue.publish.secret] : [];
    say("error", secrets, `"${venue.name}": ${message}`);
    const at = this.at();
    try {
      await this.savePublish(venue.id, (p) => ({ ...p, lastError: errorAt(at, message, [...secrets, p.secret]) }));
    } catch (err) {
      say("error", secrets, `"${venue.name}": that could not be shown on its card either: ${errorMessage(err)}`);
    }
  }

  // ── The parts ──────────────────────────────────────────────────────────────

  /** Say a refusal and answer it. Every refusal is said, so the log answers "why did Publish do nothing" as well as the card. */
  private refused(action: string, venueId: string, venue: Venue | null, status: 404 | 409, error: string): { ok: false; status: 404 | 409; error: string } {
    say("warn", venue?.publish ? [venue.publish.secret] : [], `${action} refused for ${venue ? `"${venue.name}"` : `venue ${venueId}`}: ${error}`);
    return { ok: false, status, error };
  }

  /** The venue, the page to publish to and a client for it, or why not. */
  private async venueAndTarget(
    venueId: string,
    published: boolean,
    action: string,
  ): Promise<{ ok: true; doc: StagePlotsDoc; venue: Venue; target: Target; client: PushClient; host: string } | { ok: false; status: 404 | 409; error: string }> {
    const doc = await this.deps.store.get();
    const venue = doc.venues.find((v) => v.id === venueId) ?? null;
    if (!venue) return this.refused(action, venueId, null, 404, "no such venue");
    if (published && !venue.publish) return this.refused(action, venueId, venue, 409, `${venue.name} is not published`);
    if (!published && venue.publish) return this.refused(action, venueId, venue, 409, `${venue.name} is already published`);
    const target = await this.deps.target();
    if (!target.ok) return this.refused(action, venueId, venue, 409, target.message);
    return { ok: true, doc, venue, target, client: this.client(target), host: hostOf(target.origin) };
  }

  /** A refusal when the queue is at what an action may add to, checked before anything is sent. */
  private queueFull(doc: StagePlotsDoc, action: string, name: string): { ok: false; status: 409; error: string } | null {
    const queued = doc.pendingRemovals;
    if (Array.isArray(queued) && queued.length < STAGEPLOT_LIMITS.pendingRemovalsQueue) return null;
    const error = Array.isArray(queued)
      ? `${queued.length} old links are still waiting to be removed from a page. Remove them (Remove now, once their page is set up) before this ${action.toLowerCase()}.`
      : `${DAMAGED_QUEUE} Fix the file before this ${action.toLowerCase()}.`;
    say("warn", [], `${action} refused for "${name}": ${error}`);
    return { ok: false, status: 409, error };
  }

  /**
   * A new secret, queued before its first request goes out, then the venue sent under it. On a
   * failure, what went up is taken back, and the secret leaves the queue only once it is gone.
   */
  private async sendFresh(
    client: PushClient,
    target: Target,
    doc: StagePlotsDoc,
    venue: Venue,
    required: readonly string[],
  ): Promise<{ ok: true; secret: string; r: Sent } | { ok: false; secret: string; status: 400 | 502; message: string }> {
    const secret = newPublishSecret();
    await this.queue([{ secret, origin: target.origin, since: this.at(), reason: "publishing" }]);
    const r = await this.sendVenue(client, hostOf(target.origin), secret, doc, venue, { force: true, required, held: [] });
    if (r.ok) return { ok: true, secret, r };
    if (r.sent > 0) await this.takeBack(client, secret, target.origin, venue.name);
    else await this.unqueue((e) => e.secret === secret && e.origin === target.origin);
    return { ok: false, secret, status: r.status, message: r.message };
  }

  /**
   * One write: `secret` (queued as publishing) onto the venue as its publish state, out of the
   * queue, and `old` into it. Null, and the queue left as it was, when the venue is gone.
   */
  private async promote(venueId: string, secret: string, origin: string, state: VenuePublish, old: PendingRemoval | null): Promise<Venue | null> {
    let saved: Venue | null = null;
    await this.update((d) => {
      const v = d.venues.find((x) => x.id === venueId);
      if (!v) return d;
      saved = { ...v, publish: state };
      const pending = d.pendingRemovals.filter((e) => !(e.secret === secret && e.origin === origin));
      return { ...d, venues: d.venues.map((x) => (x.id === venueId ? saved! : x)), pendingRemovals: old ? [...pending, old] : pending };
    });
    if (old) say("log", [old.secret], `an old link on ${hostOf(old.origin)} is queued for removal (${old.reason})`);
    return saved;
  }

  /** The venue unpublished, and `queued` (its secret) added to the queue in the same write. The venue as it is after. */
  private async unpublishInStore(venueId: string, queued: PendingRemoval | null): Promise<Venue | null> {
    let after: Venue | null = null;
    await this.update((d) => {
      const v = d.venues.find((x) => x.id === venueId);
      if (!v) return queued ? { ...d, pendingRemovals: [...d.pendingRemovals, queued] } : d;
      after = withoutPublish(v);
      return { ...d, venues: d.venues.map((x) => (x.id === venueId ? after! : x)), pendingRemovals: queued ? [...d.pendingRemovals, queued] : d.pendingRemovals };
    });
    this.attempted.delete(venueId);
    if (queued) say("log", [queued.secret], `a link on ${hostOf(queued.origin)} is queued for removal (${queued.reason})`);
    return after;
  }

  /** Take back what went up under a secret that will not be used. Out of the queue once gone; left in it, and said, when not. */
  private async takeBack(client: PushClient, secret: string, origin: string, name: string): Promise<void> {
    this.forget(secret);
    const r = await client.dropStagePlots(secret);
    if (r.ok) {
      await this.unqueue((e) => e.secret === secret && e.origin === origin);
      return;
    }
    // Still queued: no longer in flight, so it shows on the card and is removed as soon as it can be.
    await this.update((d) => ({ ...d, pendingRemovals: d.pendingRemovals.map((e) => (e.secret === secret && e.origin === origin ? { ...e, reason: "not taken back" as PendingReason } : e)) }));
    say("warn", [secret], `what went up for "${name}" before the failure could not be taken back (${r.message}); it is queued for removal`);
  }

  /**
   * Drain the queue: drop each secret queued against `via`'s page (the page set up, unless the
   * address-change path hands in the old one with its token). Writes only what went; a drop that
   * fails writes nothing (so it cannot loop through its own broadcast) and is said once. At
   * start, a publish left in flight by a crash that cannot be dropped becomes visible. Answers
   * the queue as it is after, how many went, and the page it was drained against; or, said on
   * [stageplots], why the queue could not be read or written, which is never "empty".
   */
  private drainQueued(atStart: boolean, via?: Target): Promise<Drained> {
    return this.serial(PENDING_CHAIN, async (): Promise<Drained> => {
      try {
        return await this.drain(atStart, via);
      } catch (err) {
        const message = `The old links waiting to be removed could not be read or saved: ${errorMessage(err)}`;
        say("error", [], message);
        return { ok: false, message };
      }
    });
  }

  private async drain(atStart: boolean, via: Target | undefined): Promise<Drained> {
    const doc = await this.deps.store.get();
    if (!Array.isArray(doc.pendingRemovals)) throw new Error(DAMAGED_QUEUE);
    if (this.paused || doc.pendingRemovals.length === 0) return { ok: true, left: doc.pendingRemovals, removed: 0, page: null };
    const set = via ?? (await this.deps.target().then((t) => (t.ok ? t : null)));
    const page = set?.origin ?? null;
    const gone: PendingRemoval[] = [];
    const stuckInFlight: PendingRemoval[] = [];
    for (const e of doc.pendingRemovals) {
      // A publish in flight is the action's own until it finishes; only a stale one (at start) is drained.
      if (e.reason === "publishing" && !atStart) continue;
      if (!set || e.origin !== set.origin) {
        if (!this.saidStuck.has(`${e.secret} wait`)) {
          this.saidStuck.add(`${e.secret} wait`);
          say("warn", [e.secret], `an old link on ${hostOf(e.origin)} (${e.reason}) waits: ${set ? "this server is set up for another page" : "no page is set up here"}; it is removed once ${hostOf(e.origin)} is set up again`);
        }
        if (e.reason === "publishing") stuckInFlight.push(e);
        continue;
      }
      const r = await this.client(set).dropStagePlots(e.secret);
      if (r.ok) {
        this.forget(e.secret);
        gone.push(e);
        say("log", [e.secret], `an old link on ${hostOf(e.origin)} is removed (${e.reason})`);
      } else {
        if (e.reason === "publishing") stuckInFlight.push(e);
        if (!this.saidStuck.has(e.secret)) {
          this.saidStuck.add(e.secret);
          say("warn", [e.secret], `an old link on ${hostOf(e.origin)} (${e.reason}) could not be removed yet: ${sentence(r, hostOf(e.origin))} It is tried again on every change, Publish now and Remove now.`);
        }
      }
    }
    if (gone.length === 0 && stuckInFlight.length === 0) return { ok: true, left: doc.pendingRemovals, removed: 0, page };
    const isGone = (e: PendingRemoval) => gone.some((g) => g.secret === e.secret && g.origin === e.origin);
    const isStuck = (e: PendingRemoval) => stuckInFlight.some((g) => g.secret === e.secret && g.origin === e.origin);
    const after = await this.update((d) => ({
      ...d,
      pendingRemovals: d.pendingRemovals.filter((e) => !isGone(e)).map((e) => (isStuck(e) ? { ...e, reason: "not taken back" as PendingReason } : e)),
    }));
    return { ok: true, left: after.pendingRemovals, removed: gone.length, page };
  }

  /** Add to the queue. */
  private async queue(entries: PendingRemoval[]): Promise<void> {
    await this.update((d) => ({ ...d, pendingRemovals: [...d.pendingRemovals, ...entries] }));
  }

  /** Take out of the queue what `which` names. */
  private async unqueue(which: (e: PendingRemoval) => boolean): Promise<void> {
    await this.update((d) => (d.pendingRemovals.some(which) ? { ...d, pendingRemovals: d.pendingRemovals.filter((e) => !which(e)) } : d));
  }

  /** A store write, broadcast when it changed anything. A write that hands back its input changes nothing. */
  private async update(fn: (doc: StagePlotsDoc) => StagePlotsDoc): Promise<StagePlotsDoc> {
    let changed = false;
    const doc = await this.deps.store.update((d) => {
      const next = fn(d);
      changed = next !== d && JSON.stringify(next) !== JSON.stringify(d);
      return changed ? next : d;
    });
    if (changed) this.deps.onSaved(doc);
    return doc;
  }

  /** Save a send's outcome on a published venue, say it, and answer. */
  private async finish(venueId: string, venue: Venue, r: SendResult, host: string, secrets: string[], what: string): Promise<PublishOutcome> {
    const at = this.at();
    if (!r.ok) {
      say("warn", secrets, `"${venue.name}" could not be ${what}: ${r.message}; the page keeps what it had`);
      const saved = await this.savePublish(venueId, (p) => ({ ...p, lastError: errorAt(at, r.message, secrets) }));
      return { ok: false, status: saved ? r.status : 404, error: saved ? hide(r.message, secrets) : "no such venue" };
    }
    const saved = await this.savePublish(venueId, (p) => stateAfterSend(p.secret, p.origin, at, r, secrets));
    if (!saved) return { ok: false, status: 404, error: "no such venue" };
    say("log", secrets, `"${venue.name}" ${what} on ${host}: ${plural(r.sent, "request")}${missingNote(r)}`);
    for (const w of r.warnings) say("warn", secrets, `"${venue.name}": ${w}`);
    return { ok: true, venue: saved };
  }

  private forget(secret: string): void {
    this.sent.delete(secret);
    this.kept.delete(secret);
    this.saidStuck.delete(secret);
    this.saidStuck.delete(`${secret} wait`);
  }

  private async venueNow(venueId: string): Promise<Venue | null> {
    return (await this.deps.store.get()).venues.find((v) => v.id === venueId) ?? null;
  }

  /** Write a published venue's publish state, made from what it is now. Null when the venue is gone or no longer published. */
  private async savePublish(venueId: string, next: (current: VenuePublish) => VenuePublish): Promise<Venue | null> {
    const doc = await this.update((d) => {
      const v = d.venues.find((x) => x.id === venueId);
      if (!v?.publish) return d;
      return { ...d, venues: d.venues.map((x) => (x.id === venueId ? { ...v, publish: next(v.publish!) } : x)) };
    });
    return doc.venues.find((v) => v.id === venueId) ?? null;
  }

  /** What a republish is built from, to tell a change to what is published from one to anything else. */
  private fingerprint(doc: StagePlotsDoc, venue: Venue): string {
    const byId = new Map(doc.backgrounds.map((b) => [b.id, b]));
    const plots = plotsOf(doc, venue).map((p) => [p, p.backgroundId ? (byId.get(p.backgroundId)?.converted ?? null) : null]);
    return docHash(JSON.stringify([publishedVenue(doc, venue, this.deps.plan(), this.deps.timeZone()), plots]));
  }

  /**
   * Send a venue under `secret`: backgrounds, plots, index, and the list of keys to keep when it
   * changed (always, when forced). Sizes are checked before anything is sent, so a plot too large to publish is a
   * refusal by name and not half a publish.
   */
  private async sendVenue(client: PushClient, host: string, secret: string, doc: StagePlotsDoc, venue: Venue, opts: SendOptions): Promise<SendResult> {
    const byId = new Map(doc.backgrounds.map((b) => [b.id, b]));
    const plots = plotsOf(doc, venue).map((plot) => ({ plot, bg: plot.backgroundId ? (byId.get(plot.backgroundId) ?? null) : null }));
    for (const { plot, bg } of plots) {
      const bytes = Buffer.byteLength(JSON.stringify(publishedPlot(plot, bg, true)));
      if (bytes > PUBLISH_MAX_BODY_BYTES) {
        return { ok: false, status: 400, sent: 0, message: `Plot "${plot.name}" is too large to publish (${mb(bytes)} MB; the limit is ${mb(PUBLISH_MAX_BODY_BYTES)} MB). Remove items or inputs from it.` };
      }
    }
    const index = JSON.stringify(publishedVenue(doc, venue, this.deps.plan(), this.deps.timeZone()));

    const sent = opts.force ? new Map<string, string>() : (this.sent.get(secret) ?? new Map<string, string>());
    this.sent.set(secret, sent);
    let count = 0;
    // A Worker from before StagePlots answers every path 404 and stored nothing, so there is nothing to take back.
    const fail = (r: PushFailure): SendResult => ({ ok: false, status: 502, message: sentence(r, host), sent: r.kind === "refused" && r.status === 404 ? 0 : count });

    // Backgrounds first: a plot names one only once the page holds it.
    const needed = venueImages(doc, venue);
    const held = new Set(opts.force ? [] : opts.held.filter((h) => needed.includes(h)));
    const unpublished: { hash: string; why: string }[] = [];
    for (const hash of needed) {
      if (held.has(hash)) continue;
      const key = stagePlotsImageKey(hash)!;
      let bytes: Uint8Array | null;
      try {
        bytes = await this.deps.image(hash);
      } catch (err) {
        unpublished.push({ hash, why: `it could not be read on this server: ${errorMessage(err)}` });
        continue;
      }
      if (bytes === null) {
        unpublished.push({ hash, why: "it is missing on this server" });
        continue;
      }
      if (bytes.byteLength > PUBLISH_MAX_BODY_BYTES) {
        unpublished.push({ hash, why: `it is too large to publish (${mb(bytes.byteLength)} MB; the limit is ${mb(PUBLISH_MAX_BODY_BYTES)} MB)` });
        continue;
      }
      const r = await client.putStagePlot(secret, key, bytes, STAGEPLOTS_IMAGE_TYPE);
      count++;
      if (r.ok) held.add(hash);
      else if (aboutThePage(r)) return fail(r);
      else unpublished.push({ hash, why: sentence(r, host) });
    }
    const lost = unpublished.filter((u) => opts.required.includes(u.hash));
    if (lost.length > 0) {
      return { ok: false, status: 502, sent: count, message: `${plural(lost.length, "background")} the old link has could not be published: ${lost[0]!.why}` };
    }

    const put = async (key: string, text: string): Promise<PushResult | null> => {
      const h = docHash(text);
      if (sent.get(key) === h) return null;
      const r = await client.putStagePlot(secret, key, text, "application/json");
      count++;
      if (r.ok) sent.set(key, h);
      return r;
    };
    for (const { plot, bg } of plots) {
      const r = await put(stagePlotsPlotKey(plot.id)!, JSON.stringify(publishedPlot(plot, bg, bg !== null && held.has(bg.converted.hash))));
      if (r && !r.ok) return fail(r);
    }
    const ir = await put(STAGEPLOTS_INDEX_KEY, index);
    if (ir && !ir.ok) return fail(ir);

    const warnings: string[] = [];
    const keys = [STAGEPLOTS_INDEX_KEY, ...plots.map(({ plot }) => stagePlotsPlotKey(plot.id)!), ...[...held].map((h) => stagePlotsImageKey(h)!)].sort();
    const keep = JSON.stringify(keys);
    if (opts.force || this.kept.get(secret) !== keep) {
      const r = await client.keepStagePlots(secret, keys);
      count++;
      if (r.ok) this.kept.set(secret, keep);
      else warnings.push(`What was taken off this venue could not be removed from ${host} yet: ${sentence(r, host)}`);
    }
    return { ok: true, sent: count, held: [...held].sort(), unpublished, warnings };
  }

}

/**
 * A venue's publish state after a send that went through: under `secret` on `origin`, the
 * backgrounds the page holds and does not, and the error the send still leaves on the card
 * (backgrounds not yet published, or what could not be pruned). One rule for a first publish,
 * a regenerate, a move and every republish.
 */
function stateAfterSend(secret: string, origin: string, at: string, r: Sent, secrets: readonly string[]): VenuePublish {
  const lastError =
    r.unpublished.length > 0
      ? errorAt(at, `${plural(r.unpublished.length, "background")} not yet published: ${r.unpublished[0]!.why}`, secrets)
      : r.warnings.length > 0
        ? errorAt(at, r.warnings[0]!, secrets)
        : null;
  return { secret, origin, publishedAt: at, lastError, publishedImages: r.held, unpublishedImages: r.unpublished.map((u) => u.hash).sort() };
}

/** "; 1 background not yet published (why)", or nothing. */
function missingNote(r: Sent): string {
  return r.unpublished.length > 0 ? `; ${plural(r.unpublished.length, "background")} not yet published (${r.unpublished[0]!.why})` : "";
}

function withoutPublish(v: Venue): Venue {
  const { publish: _publish, ...rest } = v;
  return rest;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
