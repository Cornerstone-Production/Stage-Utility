// stageplots-publish.ts — a venue's stage plots on the public page, behind a secret link.
//
// Through the same page, address, token and HTTP client as ServiceCue on the web
// (servicecue-publish-client.ts), under the StagePlots keys of the contract
// (main/types/servicecue-publish.ts): per venue, every background its plots draw, one doc
// per plot and an index, all under the venue's own secret. See docs/features/stageplots.md.
//
//   Publish        a new secret; backgrounds, then plots, then the index, which is what makes
//                  the link a page. A background the page refuses is listed as not yet
//                  published and the plot is drawn without it; anything else that fails
//                  leaves the venue unpublished and takes back what went up.
//   Regenerate     the same under a new secret, every background included, and only then is
//                  the old one deleted. A failure keeps the old link. An old link that will
//                  not delete is kept on the venue and tried again by Publish now.
//   Unpublish      deletes the venue's secret (and any old ones) on the page, then forgets it.
//                  A delete that fails leaves the venue published, and says so.
//   Publish now    everything again, every background included, and any old link removed.
//   A change       to the document, or to the plan it follows: each published venue is sent
//                  what changed, after a short wait, one run at a time per venue. A change that
//                  alters nothing published (the publish state this writes, say) sends nothing.
//
// THE SECRET IS NEVER LOGGED, never in an error sent back, never in a stored error: every
// sentence this writes goes through `hide`. It is in the store, which a LAN browser reads to
// show the link, and in config backups (see the restore rule in config-snapshot.ts).

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
import type { Background, Plot, PublishedPlot, PublishedVenue, StagePlotsDoc, Venue, VenuePublish } from "../types/stageplots.js";

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
export type PublishOutcome = { ok: true; venue: Venue; notice?: string } | { ok: false; status: 400 | 404 | 409 | 502; error: string };

/** What is said when a copy sits on a page this server no longer has a token for. */
function leftOn(oldHost: string): string {
  return `The copy published to ${oldHost} is left on ${oldHost}: this server has no token for that page any more.`;
}

/** How long a change waits for the next before it is published. */
export const REPUBLISH_WAIT_MS = 2000;

const MB = 1_000_000;
const mb = (bytes: number) => (bytes / MB).toFixed(1);

type Level = "log" | "warn" | "error";

/**
 * Every [stageplots] line this file writes: the secrets in it hidden, then scrubbed, so no
 * line can carry a secret or forge another line whatever went into it.
 */
function say(level: Level, secrets: readonly string[], message: string): void {
  if (level === "log") console.log(`[stageplots] ${scrub(hide(message, secrets), 600)}`);
  else if (level === "warn") console.warn(`[stageplots] ${scrub(hide(message, secrets), 600)}`);
  else console.error(`[stageplots] ${scrub(hide(message, secrets), 600)}`);
}

/** The longest last-error sentence the store keeps (stageplots-store.ts). */
const ERROR_CHARS = 600;

/** A venue's last error: secrets hidden, and cut to what the store keeps, so a long failure
 *  can never make the save of the publish it describes throw. */
function errorAt(at: string, message: string, secrets: readonly string[]): { at: string; message: string } {
  const text = hide(message, secrets);
  return { at, message: text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS - 1)}…` : text };
}

/** `text` with every secret in it replaced: what may be logged, stored or sent back. */
function hide(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("<secret>");
  return out;
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
  /** Send every doc and every background, whatever this process last sent. */
  force: boolean;
  /** Backgrounds that must go through, or the whole send fails: what the old link held (regenerate). */
  required: readonly string[];
  /** The backgrounds the page holds under this secret already. */
  held: readonly string[];
}

// ── The publisher ────────────────────────────────────────────────────────────

export class StagePlotsPublisher {
  private readonly deps: StagePlotsPublishDeps;
  private readonly waitMs: number;
  /** Per venue, the run in progress: every action and republish of a venue waits for the one before. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Per secret, the hash of each key's text as last sent, so a republish sends only what changed. */
  private readonly sent = new Map<string, Map<string, string>>();
  /** Per secret, the keys last kept. */
  private readonly kept = new Map<string, string>();
  /** Per venue, what the last republish was built from, sent or not: the same again is not tried again. */
  private readonly attempted = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDone: Promise<void> = Promise.resolve();
  private planKey: string | null = null;
  private started = false;
  private stopped = false;

  constructor(deps: StagePlotsPublishDeps) {
    this.deps = deps;
    this.waitMs = deps.debounceMs ?? REPUBLISH_WAIT_MS;
  }

  /** Listen for changes. Once; the broadcaster has no way to take a listener back. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.planKey = this.currentPlanKey();
    this.deps.listen?.((channel) => this.heard(channel));
  }

  /** Shutdown: no more republishing, and whatever is running finishes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.all([...this.chains.values()]);
  }

  /** Every pending wait has fired and every run it queued has finished. For tests and the drive. */
  async settle(): Promise<void> {
    for (;;) {
      await this.timerDone;
      await Promise.all([...this.chains.values()]);
      if (this.timer === null) return;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private client(target: { origin: PublishOrigin; token: string }): PushClient {
    return (this.deps.client ?? ((t) => createPushClient(t)))(target);
  }

  private currentPlanKey(): string {
    const p = this.deps.plan();
    return JSON.stringify([p.planId, p.planDates]);
  }

  private heard(channel: string): void {
    if (this.stopped) return;
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
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    let fire!: () => void;
    this.timerDone = new Promise((resolve) => (fire = resolve));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.republishAll().finally(fire);
    }, this.waitMs);
    this.timer.unref?.();
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
        say("error", [pub.secret, ...pub.retired], `"${venue.name}" could not be republished: ${errorMessage(err)}`);
      });
    }
  }

  /** Run `fn` after whatever this venue is already running. */
  private serial<T>(venueId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(venueId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(venueId, tail);
    void tail.then(() => {
      if (this.chains.get(venueId) === tail) this.chains.delete(venueId);
    });
    return run;
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  publish(venueId: string): Promise<PublishOutcome> {
    return this.serial(venueId, async () => {
      const found = await this.venueAndTarget(venueId, false, "Publish");
      if (!found.ok) return found;
      const { doc, venue, target, client, host } = found;
      const secret = newPublishSecret();
      const r = await this.sendVenue(client, host, secret, doc, venue, { force: true, required: [], held: [] });
      if (!r.ok) {
        if (r.sent > 0) await this.takeBack(client, secret, venue.name);
        say("warn", [secret], `"${venue.name}" was not published: ${r.message}`);
        return { ok: false, status: r.status, error: hide(r.message, [secret]) };
      }
      const at = new Date(this.now()).toISOString();
      const saved = await this.savePublish(venueId, () => ({
        secret,
        origin: target.origin,
        publishedAt: at,
        lastError: this.problemOf(r, at, [secret]),
        publishedImages: r.held,
        unpublishedImages: r.unpublished.map((u) => u.hash).sort(),
        retired: [],
      }));
      if (!saved) {
        // Deleted while it was being published: nothing would ever remove what went up.
        await this.takeBack(client, secret, venue.name);
        return { ok: false, status: 404, error: "no such venue" };
      }
      this.attempted.set(venueId, this.fingerprint(doc, venue));
      const plots = plotsOf(doc, venue).length;
      const missing = r.unpublished.length > 0 ? `; ${plural(r.unpublished.length, "background")} not yet published (${r.unpublished[0]!.why})` : "";
      say("log", [secret], `"${venue.name}" published to ${host}: ${plural(plots, "plot")} and ${plural(r.held.length, "background")}${missing}`);
      return { ok: true, venue: saved };
    });
  }

  regenerate(venueId: string): Promise<PublishOutcome> {
    return this.serial(venueId, async () => {
      const found = await this.venueAndTarget(venueId, true, "Regenerate");
      if (!found.ok) return found;
      const { doc, venue, target, client, host } = found;
      const pub = venue.publish!;
      const secret = newPublishSecret();
      const all = [secret, pub.secret, ...pub.retired];
      const r = await this.sendVenue(client, host, secret, doc, venue, { force: true, required: pub.publishedImages, held: [] });
      if (!r.ok) {
        if (r.sent > 0) await this.takeBack(client, secret, venue.name);
        const message = `The link was not changed: ${r.message}`;
        say("warn", all, `"${venue.name}": ${message}`);
        const at = new Date(this.now()).toISOString();
        await this.savePublish(venueId, (p) => ({ ...p, lastError: errorAt(at, message, all) }));
        return { ok: false, status: r.status, error: hide(message, all) };
      }
      // The new link is saved before anything under the old is touched: a crash between the two
      // leaves the old secret on the venue, waiting to be removed, rather than nowhere.
      const at = new Date(this.now()).toISOString();
      const saved = await this.savePublish(venueId, (p) => ({
        secret,
        origin: target.origin,
        publishedAt: at,
        lastError: this.problemOf(r, at, all),
        publishedImages: r.held,
        unpublishedImages: r.unpublished.map((u) => u.hash).sort(),
        retired: [...new Set([...p.retired, p.secret])].sort(),
      }));
      if (!saved) {
        await this.takeBack(client, secret, venue.name);
        return { ok: false, status: 404, error: "no such venue" };
      }
      this.attempted.set(venueId, this.fingerprint(doc, venue));
      const left = await this.removeRetired(venueId, client, host, venue.name);
      // Published to a page whose address has since changed: the old link's copy is there, and
      // a delete sent here (204 for nothing) removed nothing of it.
      const moved = pub.origin !== target.origin ? new URL(pub.origin).host : null;
      if (moved && left === null) {
        await this.savePublish(venueId, (p) => ({ ...p, lastError: errorAt(at, leftOn(moved), all) }));
      }
      const oldOne = moved ? `the old link's copy is left on ${moved}` : left === null ? "the old one is removed" : `the old one could not be removed yet (${left})`;
      say("log", all, `"${venue.name}" has a new link on ${host}; ${oldOne}`);
      return { ok: true, venue: (await this.venueNow(venueId)) ?? saved };
    });
  }

  unpublish(venueId: string): Promise<PublishOutcome> {
    return this.serial(venueId, async () => {
      const found = await this.venueAndTarget(venueId, true, "Unpublish");
      if (!found.ok) return found;
      const { venue, target, client, host } = found;
      const pub = venue.publish!;
      const all = [pub.secret, ...pub.retired];
      const moved = pub.origin !== target.origin ? new URL(pub.origin).host : null;
      // Old links first: the venue's own is the one the card shows, and it goes last.
      const gone: string[] = [];
      for (const s of [...pub.retired, pub.secret]) {
        const r = await client.dropStagePlots(s);
        if (!r.ok) {
          const message = `${sentence(r, host)} Nothing was unpublished, so the link still works.`;
          say("warn", all, `"${venue.name}" could not be unpublished: ${message}`);
          const at = new Date(this.now()).toISOString();
          await this.savePublish(venueId, (p) => ({ ...p, retired: p.retired.filter((x) => !gone.includes(x)), lastError: errorAt(at, message, all) }));
          return { ok: false, status: 502, error: hide(message, all) };
        }
        gone.push(s);
        this.forget(s);
      }
      const doc = await this.deps.store.update((d) => ({ ...d, venues: d.venues.map((v) => (v.id === venueId ? withoutPublish(v) : v)) }));
      this.deps.onSaved(doc);
      this.attempted.delete(venueId);
      say("log", [], `"${venue.name}" unpublished: its link and backgrounds are removed from ${host}`);
      if (moved) say("warn", [], `"${venue.name}": ${leftOn(moved)}`);
      const after = doc.venues.find((v) => v.id === venueId);
      if (!after) return { ok: false, status: 404, error: "no such venue" };
      return moved ? { ok: true, venue: after, notice: leftOn(moved) } : { ok: true, venue: after };
    });
  }

  publishNow(venueId: string): Promise<PublishOutcome> {
    return this.serial(venueId, async () => {
      const found = await this.venueAndTarget(venueId, true, "Publish now");
      if (!found.ok) return found;
      const { doc, venue, target, client, host } = found;
      const pub = venue.publish!;
      const all = [pub.secret, ...pub.retired];
      const left = pub.retired.length > 0 ? await this.removeRetired(venueId, client, host, venue.name) : null;
      const r = await this.sendVenue(client, host, pub.secret, doc, venue, { force: true, required: [], held: [] });
      this.attempted.set(venueId, this.fingerprint(doc, venue));
      return this.finish(venueId, venue, r, target, host, all, left, "published again");
    });
  }

  /** A change: send what differs from what was last sent. Nothing at all when nothing published changed. */
  private async republish(venueId: string): Promise<void> {
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
    const all = [pub.secret, ...pub.retired];
    const target = await this.deps.target();
    if (!target.ok) {
      say("warn", all, `"${venue.name}" changed and could not be republished: ${target.message}`);
      const at = new Date(this.now()).toISOString();
      await this.savePublish(venueId, (p) => ({ ...p, lastError: errorAt(at, target.message, all) }));
      return;
    }
    const host = new URL(target.origin).host;
    const moved = pub.origin !== target.origin;
    if (moved) {
      say("warn", [], `the page address changed: "${venue.name}" is published to ${host} under the same link, and its copy on ${new URL(pub.origin).host} is left there`);
    }
    const r = await this.sendVenue(this.client(target), host, pub.secret, doc, venue, { force: moved, required: [], held: moved ? [] : pub.publishedImages });
    if (r.ok && r.sent === 0 && sameList(r.held, pub.publishedImages) && sameList(r.unpublished.map((u) => u.hash).sort(), pub.unpublishedImages) && r.warnings.length === 0) {
      return;
    }
    await this.finish(venueId, venue, r, target, host, all, null, "republished");
  }

  // ── The parts ──────────────────────────────────────────────────────────────

  /** The venue, the page to publish to and a client for it, or why not. */
  private async venueAndTarget(
    venueId: string,
    published: boolean,
    action: string,
  ): Promise<
    | { ok: true; doc: StagePlotsDoc; venue: Venue; target: { origin: PublishOrigin; token: string }; client: PushClient; host: string }
    | { ok: false; status: 404 | 409; error: string }
  > {
    const doc = await this.deps.store.get();
    const venue = doc.venues.find((v) => v.id === venueId);
    // Every refusal is said, so the log answers "why did Publish do nothing" as well as the card.
    const refused = (status: 404 | 409, error: string) => {
      say("warn", venue?.publish ? [venue.publish.secret, ...venue.publish.retired] : [], `${action} refused for ${venue ? `"${venue.name}"` : `venue ${venueId}`}: ${error}`);
      return { ok: false as const, status, error };
    };
    if (!venue) return refused(404, "no such venue");
    if (published && !venue.publish) return refused(409, `${venue.name} is not published`);
    if (!published && venue.publish) return refused(409, `${venue.name} is already published`);
    const target = await this.deps.target();
    if (!target.ok) return refused(409, target.message);
    return { ok: true, doc, venue, target, client: this.client(target), host: new URL(target.origin).host };
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

  /** Save a send's outcome on a published venue, say it, and answer. */
  private async finish(
    venueId: string,
    venue: Venue,
    r: SendResult,
    target: { origin: PublishOrigin },
    host: string,
    secrets: string[],
    retiredLeft: string | null,
    what: string,
  ): Promise<PublishOutcome> {
    const at = new Date(this.now()).toISOString();
    if (!r.ok) {
      say("warn", secrets, `"${venue.name}" could not be ${what}: ${r.message}; the page keeps what it had`);
      const saved = await this.savePublish(venueId, (p) => ({ ...p, lastError: errorAt(at, r.message, secrets) }));
      return { ok: false, status: saved ? r.status : 404, error: saved ? hide(r.message, secrets) : "no such venue" };
    }
    const saved = await this.savePublish(venueId, (p) => ({
      ...p,
      origin: target.origin,
      publishedAt: at,
      lastError: retiredLeft !== null ? errorAt(at, retiredLeft, secrets) : this.problemOf(r, at, secrets),
      publishedImages: r.held,
      unpublishedImages: r.unpublished.map((u) => u.hash).sort(),
    }));
    if (!saved) return { ok: false, status: 404, error: "no such venue" };
    const missing = r.unpublished.length > 0 ? `; ${plural(r.unpublished.length, "background")} not yet published (${r.unpublished[0]!.why})` : "";
    say("log", secrets, `"${venue.name}" ${what} on ${host}: ${plural(r.sent, "request")}${missing}`);
    for (const w of r.warnings) say("warn", secrets, `"${venue.name}": ${w}`);
    return { ok: true, venue: saved };
  }

  /** The error a send that went through still leaves on the card: backgrounds not yet published, or what could not be pruned. */
  private problemOf(r: Extract<SendResult, { ok: true }>, at: string, secrets: string[]): VenuePublish["lastError"] {
    if (r.unpublished.length > 0) return errorAt(at, `${plural(r.unpublished.length, "background")} not yet published: ${r.unpublished[0]!.why}`, secrets);
    if (r.warnings.length > 0) return errorAt(at, r.warnings[0]!, secrets);
    return null;
  }

  /** Remove the venue's earlier secrets from the page. Null when all went; else what was said. */
  private async removeRetired(venueId: string, client: PushClient, host: string, name: string): Promise<string | null> {
    const venue = await this.venueNow(venueId);
    const retired = venue?.publish?.retired ?? [];
    const left: string[] = [];
    let why: string | null = null;
    for (const s of retired) {
      const r = await client.dropStagePlots(s);
      if (r.ok) this.forget(s);
      else {
        left.push(s);
        why ??= sentence(r, host);
      }
    }
    if (retired.length === 0) return null;
    const message = why === null ? null : `The old link could not be removed from ${host} yet: ${why} Publish now tries again.`;
    const at = new Date(this.now()).toISOString();
    await this.savePublish(venueId, (p) => ({ ...p, retired: left, ...(message ? { lastError: errorAt(at, message, [p.secret, ...retired]) } : {}) }));
    if (message) say("warn", [...retired, venue?.publish?.secret ?? ""], `"${name}": ${message}`);
    return message;
  }

  /** Take back what went up under a secret that will not be used. Said, never thrown: the caller is reporting the failure that led here. */
  private async takeBack(client: PushClient, secret: string, name: string): Promise<void> {
    this.forget(secret);
    const r = await client.dropStagePlots(secret);
    if (!r.ok) {
      // Nothing points at it and the secret was never shown, so nobody can reach what is left.
      say("warn", [secret], `what went up for "${name}" before the failure could not be taken back (${r.message}); the link was never shown, so nothing can reach it`);
    }
  }

  private forget(secret: string): void {
    this.sent.delete(secret);
    this.kept.delete(secret);
  }

  private async venueNow(venueId: string): Promise<Venue | null> {
    return (await this.deps.store.get()).venues.find((v) => v.id === venueId) ?? null;
  }

  /**
   * Write a venue's publish state, made from what it is now (undefined before the first), and
   * broadcast it. Null when the venue is gone. A state the same as what is stored writes nothing.
   */
  private async savePublish(venueId: string, next: (current: VenuePublish) => VenuePublish): Promise<Venue | null> {
    let changed = false;
    const doc = await this.deps.store.update((d) => {
      const at = d.venues.findIndex((v) => v.id === venueId);
      if (at < 0) return d;
      const v = d.venues[at]!;
      const publish = next(v.publish as VenuePublish);
      if (JSON.stringify(publish) === JSON.stringify(v.publish)) return d;
      changed = true;
      return { ...d, venues: d.venues.map((x, i) => (i === at ? { ...v, publish } : x)) };
    });
    if (changed) this.deps.onSaved(doc);
    return doc.venues.find((v) => v.id === venueId) ?? null;
  }

}

function withoutPublish(v: Venue): Venue {
  const { publish: _publish, ...rest } = v;
  return rest;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
