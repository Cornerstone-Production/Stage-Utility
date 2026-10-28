// servicecue-publisher.ts — pushes ServiceCue's data out to the public page.
//
// The server never accepts a connection from the internet. It SENDS, over HTTPS, to a page the
// operator deployed, and volunteers open that page instead of the app. The wire is
// main/types/servicecue-publish.ts, the HTTP is servicecue-publish-client.ts, what may leave is
// servicecue-publish-docs.ts. What is left here is WHEN, and what to do when it does not work.
//
//   a cycle, every minute   the small local documents, the rundowns (Planning Center, see below),
//                           the live channels, the logo, and a manifest when what the page should
//                           keep changed. A document is sent only when its text changed.
//   a trickle               the other plans in the switcher, one at a time with a gap between.
//   frames, about 1/s       the app's own live channels as it broadcasts them.
//   a heartbeat, every 30 s so the page can tell silence from a quiet service.
//   a status, every 5 min   what the page holds, so one that lost something is sent it again.
//
// ONE RUN AT A TIME. Everything a run knows (what it has sent, what is failing, its target and its
// timers) is one object made when publishing starts and dropped when it stops or its settings
// change. Every request is made through `send`, which refuses work from any run but the current
// one, so a loop left suspended across a restart cannot send to the new address with the new token.
//
// SUNDAY COMES FIRST. Planning Center is read through the gate and cache the live poller shares
// (pco-service.ts). A round is skipped whole while the gate reports tight headroom, and outside the
// service windows the app already knows about (service-window.ts) the plan list is read hourly and
// each plan every few hours, not every minute and every quarter hour.
//
// WHEN A REQUEST FAILS the sender backs off (5 s, doubling to 5 min) and probes with a heartbeat. The
// probe only says the page is there: the backoff and the problem clear when the request that failed
// succeeds, so a request the page keeps refusing does not loop at the shortest wait. A failure that
// waiting cannot fix (a rejected token, a Cloudflare rule, another protocol, an address that is not
// the page) stops publishing until the settings change, or until the page is deployed from this
// server: a page of another protocol is handed to the deployer with the build it serves, and a
// deploy starts publishing again. For a few minutes after one, the old Worker still answering is
// waited out on the backoff instead.

import { addBroadcastListener } from "./broadcaster.js";
import { errorMessage } from "./errors.js";
import { plural } from "./plural.js";
import { DEFAULT_SETTLE_MS, OutageLog } from "./repeat-log.js";
import { scrub } from "./scrub.js";
import { Ticker } from "./ticker.js";
import {
  brandingAssetName,
  countUpcoming,
  docHash,
  landingTypeIds,
  landingTypes,
  liveFingerprint,
  mergePlans,
  publicLive,
  publicSpl,
  publicState,
  startOfToday,
  upcomingDoc,
  type KnownPlan,
  type PublicLive,
  type PublicSpl,
} from "./servicecue-publish-docs.js";
import { createPushClient, FAILURE_LOG_MAX, failureForLog, problemOf, type PageStatus, type PushClient, type PushFailure, type PushResult } from "./servicecue-publish-client.js";
import type { DeployHook } from "./servicecue-deployer.js";
import { checkPublishToken, parsePublishUrl, type PublishOrigin } from "./servicecue-publish-rules.js";
import type { ServiceCuePublishSettings } from "./servicecue-publish-store.js";
import type {
  PcoLiveDTO,
  ServiceCueConfig,
  ServiceCueLayout,
  ServiceCueRundownDTO,
  ServiceSplHistory,
  ServiceTypeDTO,
  StageState,
  UpcomingPlansDTO,
} from "../types/stage.js";
import type { CategoryRole } from "../types/servicecue-roles.js";
import type { PublishProblem, PublisherStatus, SourceProblem } from "../types/servicecue-publish-status.js";
import { FIXED_DOC_KEYS, FRAME_DOCS, PUBLISH_UPCOMING_DAYS, assetContentType, isFrameChannel, rundownKey, type FrameChannel, type PublicState } from "../types/servicecue-publish.js";

// ── Cadence ──────────────────────────────────────────────────────────────────

export interface PublisherTimings {
  /** The local documents and, while a window is open, the rundowns. */
  cycleMs: number;
  /** How often the page hears from us even when nothing changed. */
  heartbeatMs: number;
  /** How often each of the other switcher plans is read again, and how often outside the service windows. */
  slowEveryMs: number;
  dormantSlowEveryMs: number;
  /** How often the plan list and the rundowns are read outside the service windows. */
  dormantRefreshMs: number;
  /** The gap between one of those reads and the next. */
  staggerMs: number;
  /** When a plan whose read failed is tried again. */
  failRetryMs: number;
  /** At most one frame per channel per this long. */
  frameMs: number;
  /** The first wait after a failure, doubling to `backoffMaxMs`. */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** How soon the first cycle runs after publishing is switched on. */
  firstCycleMs: number;
  /** How soon a cycle runs after somebody edits the layouts, roles or landing page. */
  nudgeMs: number;
  /** How often the page is asked what it holds. */
  reconcileMs: number;
  /** How long a success must hold before an outage is over: a page that flaps is one outage, not one per flap. */
  outageSettleMs: number;
  /** How long after this server deployed the page another protocol is the old Worker still answering, retried rather than held. */
  deploySettleMs: number;
}

export const DEFAULT_TIMINGS: PublisherTimings = {
  cycleMs: 60_000,
  heartbeatMs: 30_000,
  slowEveryMs: 15 * 60_000,
  dormantSlowEveryMs: 4 * 60 * 60_000,
  dormantRefreshMs: 60 * 60_000,
  staggerMs: 2_000,
  failRetryMs: 5 * 60_000,
  frameMs: 1_000,
  backoffMinMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  firstCycleMs: 1_000,
  nudgeMs: 1_000,
  reconcileMs: 5 * 60_000,
  outageSettleMs: DEFAULT_SETTLE_MS,
  deploySettleMs: 2 * 60_000,
};

/** How long to wait after `failures` failures in a row: 5 s, 10 s, 20 s … up to the ceiling. */
export function backoffMs(failures: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, minMs * 2 ** Math.max(0, failures - 1));
}

// ── What the publisher reads ─────────────────────────────────────────────────

/**
 * Where the documents come from: the SAME functions the in-building routes call, so a document
 * has exactly the shape the page already knows how to read. A seam so a test can supply a
 * fixture; servicecue-publisher-instance.ts supplies the app.
 */
export interface PublishSource {
  config(): Promise<ServiceCueConfig>;
  layouts(): Promise<ServiceCueLayout[]>;
  roles(): Promise<CategoryRole[]>;
  state(): StageState;
  /** The zone the app's clocks run in: what the page is told, never the state's own null. */
  timeZone(): string;
  live(): PcoLiveDTO | null;
  spl(): ServiceSplHistory | null;
  serviceTypes(): Promise<ServiceTypeDTO[]>;
  upcoming(days: number): Promise<UpcomingPlansDTO>;
  rundown(typeId: string, planId: string | null): Promise<ServiceCueRundownDTO>;
  /** Is the Planning Center gate reporting tight headroom right now? */
  pcoTight(): boolean;
  /** Is it between the service windows, with the schedule known? Planning Center is read slowly then. */
  dormant(): boolean;
  /** A stored branding image's bytes, or null when the file is not there. */
  brandingImage(name: string): Promise<{ data: Uint8Array; mime: string } | null>;
}

export interface PublisherDeps {
  source: PublishSource;
  loadSettings(): Promise<ServiceCuePublishSettings>;
  /** The token saved for this page, or "" when none is. */
  loadToken(origin: PublishOrigin): Promise<string>;
  /** The app version sent with every heartbeat. */
  version(): string;
  /** Told what build the page serves each time its status is read, and when publishing stops: it keeps the page itself up to date. */
  deploy?: DeployHook;
  timings?: Partial<PublisherTimings>;
  /** Registers the callback the app's broadcaster calls for every channel. */
  listen?: (cb: (channel: string, payload: unknown) => void) => void;
}

// ── One run ──────────────────────────────────────────────────────────────────

interface Target {
  origin: PublishOrigin;
  token: string;
}

/** Whether the old page was asked to forget its copy, and said it would. */
export type DropResult = { ok: true } | { ok: false; message: string };

type CycleOutcome = "done" | "skip";

/** A request this side stopped, or did not make, with no word from the page. */
const STOPPED: PushFailure = { ok: false, kind: "aborted", message: "Stopped." };
const HELD: PushFailure = { ok: false, kind: "aborted", message: "Not sent: publishing is held." };
/** What a request that turned out to be unnecessary answers. Compared by identity. */
const UNCHANGED: PushResult = { ok: true };

/** The live frames go out only once what is public is known; the state does not wait. */
const FRAME_ORDER: readonly FrameChannel[] = ["stage:state-changed", "pco:live", "spl:history"];

/** What one read said: its value, or why there is none. */
type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Everything one run knows. Made when publishing starts, dropped when it stops or its settings
 * change: nothing here is ever reset, so nothing here can be left over from the run before.
 */
class Run {
  readonly abort = new AbortController();
  readonly client: PushClient;
  /** Failing runs, said once per outage: the page, each read, each refused frame or manifest. */
  readonly outage: OutageLog;
  ticker: Ticker<CycleOutcome> | null = null;

  // How it is going.
  verified = false;
  delivered = false;
  /** A failure waiting can fix: backing off, shown on the card. */
  problem: PublishProblem | null = null;
  /** A failure only a settings change can fix: nothing more is sent. */
  held: PublishProblem | null = null;
  /** Each request that has failed, with how many times in a row. */
  readonly failures = new Map<string, number>();
  cycleFailed = false;
  retryAt = 0;
  lastSentAt: number | null = null;
  counts = { types: 0, layouts: 0 };
  nudged = false;
  cycling = false;

  // What the page holds, as far as we know. A document key maps to the fingerprint of what it was last given.
  readonly sent = new Map<string, string>();
  readonly refused = new Map<string, string>();
  readonly assets = { sent: new Set<string>(), refused: new Set<string>() };
  readonly nextDue = new Map<string, number>();
  readonly currentKeys = new Set<string>();
  /** The manifest the page last accepted, and what the last status said it holds. */
  manifestKey: string | null = null;
  pageHolds: PageStatus | null = null;
  lastReconcileAt = 0;

  // What we know about the install.
  readonly known: { landingIds: string[]; plans: KnownPlan[]; pcoConfigured: boolean } = { landingIds: [], plans: [], pcoConfigured: false };
  haveConfig = false;
  havePlans = false;
  /** The landing types the last plan list could not read in full. */
  incompleteTypes: string[] = [];
  /** Each Planning Center read that failed the last time it ran, by the document it is for, with why. */
  readonly sourceFailures = new Map<string, string>();
  lastPcoAt = 0;
  forcePco = false;
  heldForPco = false;

  // Work in flight.
  tail: Promise<unknown> = Promise.resolve();
  trickling: Promise<void> | null = null;
  flushing: Promise<void> = Promise.resolve();
  readonly pending = new Set<FrameChannel>();
  lastFlushAt = 0;
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  flushTimer: ReturnType<typeof setTimeout> | null = null;
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly target: Target,
    settleMs: number,
  ) {
    this.client = createPushClient({ origin: target.origin, token: target.token, signal: this.abort.signal });
    this.outage = new OutageLog(settleMs);
  }
}

export class ServiceCuePublisher {
  private readonly deps: PublisherDeps;
  private timings: PublisherTimings;
  private settings: ServiceCuePublishSettings = { enabled: false, url: "" };
  /** Why publishing could not start, when it was asked to: there is no run to say. */
  private configProblem: PublishProblem | null = null;
  private run: Run | null = null;
  private listening = false;
  /** Has this process ever had a request accepted by a page? If not, there is nothing out there for it to drop. */
  private everSent = false;
  private applying: Promise<unknown> = Promise.resolve();

  /** When this server last deployed the page. */
  private deployedAt = 0;

  constructor(deps: PublisherDeps) {
    this.deps = deps;
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    deps.deploy?.onDeployed(() => this.pageDeployed());
  }

  /**
   * The page was deployed from this server, on its own account or by "Update the page now". A run held
   * by the page (another protocol, most often) starts again: the Worker that held it has been replaced.
   */
  pageDeployed(): void {
    this.deployedAt = Date.now();
    if (!this.run?.held) return;
    console.log("[publish] the page was deployed from this server, so publishing starts again");
    // start() is apply() that puts a failure on the card and the log: there is no caller here to hand it to.
    void this.start();
  }

  /** Replace some timings. For a test that must not wait out a real minute. */
  setTimings(timings: Partial<PublisherTimings>): void {
    this.timings = { ...this.timings, ...timings };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Boot: read the settings and the token and, if publishing is on, start. Never rejects, and
   * makes no request: the first one is a timer away.
   */
  async start(): Promise<void> {
    try {
      await this.apply();
    } catch (err) {
      // Not rethrown into a boot that has nobody to tell: it becomes the problem the settings
      // card shows, and a line on /log.
      this.configProblem = { kind: "config", message: `Publishing could not start: ${errorMessage(err)}` };
      console.error(`[publish] could not start: ${scrub(errorMessage(err))}`);
    }
  }

  /**
   * The settings changed (or this is boot): stop whatever is running and start again from what
   * the stores say now. Calls queue, so two quick edits cannot interleave.
   *
   * `dropCopy` is for the call that switches publishing OFF. The page being left, by that or by a
   * change of address, is asked to forget what it holds, with the token it was sent with, and what
   * it answered comes back so the card can say so if it could not.
   */
  apply(opts: { dropCopy?: boolean } = {}): Promise<{ dropped?: DropResult }> {
    const run = this.applying.then(() => this.applyNow(opts));
    this.applying = run.catch(() => undefined);
    return run;
  }

  private async applyNow(opts: { dropCopy?: boolean }): Promise<{ dropped?: DropResult }> {
    const was = this.run?.target ?? null;
    const wasRunning = this.run !== null;
    this.halt();
    this.configProblem = null;
    try {
      this.settings = await this.deps.loadSettings();
    } catch (err) {
      // Kept off, and said on the card: nothing runs on a guess.
      this.settings = { enabled: false, url: "" };
      this.configProblem = { kind: "config", message: `The publishing settings could not be read: ${errorMessage(err)}` };
      console.error(`[publish] could not read the publishing settings: ${scrub(err)}`);
      return {};
    }

    if (!this.settings.enabled) {
      if (wasRunning) console.log("[publish] switched off");
      return opts.dropCopy ? { dropped: await this.dropOldCopy(was) } : {};
    }

    const parsed = parsePublishUrl(this.settings.url);
    if (!parsed.ok) return this.holdForConfig(parsed.message);
    let token: string;
    try {
      token = (await this.deps.loadToken(parsed.origin)).trim();
    } catch (err) {
      this.configProblem = { kind: "config", message: `The publishing token could not be read: ${errorMessage(err)}` };
      console.error(`[publish] could not read the publishing token: ${scrub(errorMessage(err))}`);
      return {};
    }
    const why = token === "" ? "No publishing token is set." : checkPublishToken(token);
    if (why !== null) return this.holdForConfig(why);

    // Moving to another page leaves the old one holding its last rundown, and only this process knows the token that can clear it.
    const dropped = was && was.origin !== parsed.origin ? await this.dropOldCopy(was) : undefined;
    this.begin({ origin: parsed.origin, token });
    return dropped ? { dropped } : {};
  }

  /** The address or the token cannot be used: nothing is sent, and the card says why. */
  private holdForConfig(why: string): Record<string, never> {
    this.configProblem = { kind: "config", message: why };
    console.warn(`[publish] publishing is held — ${scrub(why)} Change the address or the token to try again.`);
    return {};
  }

  /** Shutdown: stop cleanly. The page keeps what it holds; a restart is not a reason to blank it. */
  stop(): void {
    this.halt();
  }

  /** Drop the run: cut what is in flight, stop every timer. What the next run needs it makes for itself. */
  private halt(): void {
    const run = this.run;
    this.run = null;
    if (run) this.teardown(run);
    // Nothing is looking at the page any more: nothing waits to update it.
    this.deps.deploy?.stop();
  }

  /** Stop a run's activity. Whether it is still `this.run` (held, for the card to read) is the caller's. */
  private teardown(run: Run): void {
    run.abort.abort();
    run.ticker?.cancel();
    if (run.retryTimer) clearTimeout(run.retryTimer);
    if (run.flushTimer) clearTimeout(run.flushTimer);
    if (run.heartbeatTimer) clearInterval(run.heartbeatTimer);
    run.retryTimer = run.flushTimer = run.heartbeatTimer = null;
    run.pending.clear();
  }

  private begin(target: Target): void {
    const run = new Run(target, this.timings.outageSettleMs);
    this.run = run;
    run.ticker = new Ticker<CycleOutcome>({
      tick: () => this.cycle(run),
      nextDelayMs: () => (run.nudged ? this.timings.nudgeMs : this.timings.cycleMs),
      // Not while backing off, and not once replaced: the probe starts the cycles again after a wait.
      wanted: () => this.run === run && !this.blocked(run),
    });
    console.log(`[publish] switched on — sending to ${scrub(new URL(target.origin).host)}`);
    this.listen();
    run.heartbeatTimer = setInterval(() => void this.beat(run), this.timings.heartbeatMs);
    run.heartbeatTimer.unref?.();
    run.ticker.arm(this.timings.firstCycleMs);
  }

  /** Register with the app's broadcaster, once for the life of the process: it has no way to take a listener back. */
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    (this.deps.listen ?? addBroadcastListener)((channel) => this.onBroadcast(channel));
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  status(): PublisherStatus {
    const enabled = this.settings.enabled;
    const run = this.run;
    const problem = enabled ? (this.configProblem ?? run?.held ?? run?.problem ?? null) : null;
    const today = startOfToday(this.deps.source.timeZone());
    return {
      enabled,
      state: !enabled ? "off" : problem ? "problem" : "publishing",
      lastSentAt: run?.lastSentAt ?? null,
      lastError: problem,
      sourceProblem: enabled && run ? this.sourceProblem(run) : null,
      counts: { types: run?.counts.types ?? 0, plans: run ? countUpcoming(this.plansOf(run), today) : 0, layouts: run?.counts.layouts ?? 0 },
      now: Date.now(),
    };
  }

  /** Why Planning Center could not be read, from the first failed read of a document the page still wants: none while it is not connected. */
  private sourceProblem(run: Run): SourceProblem | null {
    const wanted = new Set(this.wantedDocs(run));
    const failed = [...run.sourceFailures].find(([key]) => wanted.has(key));
    return failed ? { message: scrub(failed[1]) } : null;
  }

  /** The layouts, roles or landing page were edited: bring the page up to date soon. */
  nudge(): void {
    const run = this.run;
    if (!run) return;
    run.nudged = true;
    run.forcePco = true;
    if (!run.cycling) run.ticker?.arm(this.timings.nudgeMs);
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /** Held, or waiting out a failure. */
  private blocked(run: Run): boolean {
    return run.held !== null || run.retryAt > Date.now();
  }

  /** Still the current run, and sending. */
  private alive(run: Run): boolean {
    return this.run === run && !this.blocked(run);
  }

  /**
   * Every request goes through here, one at a time and in order. The page is a small free service,
   * so one request in flight is gentle; and a frame can never pass the document it follows. A request
   * for a run that is no longer the current one, or while publishing is held or backing off, is not
   * made at all.
   *
   * `unless` is asked when the request's TURN comes, not when it is queued. A document wanted by the
   * cycle and by a broadcast at once would otherwise be sent twice: both look, both see the page
   * does not have it yet, and both go.
   */
  private send(run: Run, item: string, fn: (c: PushClient) => Promise<PushResult>, unless?: () => boolean): Promise<PushResult> {
    const go = async (): Promise<PushResult> => {
      if (this.run !== run) return STOPPED;
      if (unless?.()) return UNCHANGED;
      if (this.blocked(run)) return HELD;
      const result = await fn(run.client);
      // Dropped on the floor if the run was replaced while the request was in flight: its outcome describes a target that is gone.
      if (this.run === run) this.after(run, item, result);
      return result;
    };
    const next = run.tail.then(go, go);
    run.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private after(run: Run, item: string, r: PushResult): void {
    if (r.ok) {
      this.succeeded(run, item);
      return;
    }
    switch (r.kind) {
      case "aborted":
      case "refused":
        // Not about the page: this side stopped, or the page would not take that one thing. Its caller reports it.
        return;
      case "protocol":
        // Just after a deploy from here, the old Worker may still be answering: wait that out.
        if (Date.now() - this.deployedAt < this.timings.deploySettleMs) {
          this.failed(run, item, problemOf(r), r.detail);
          return;
        }
        this.hold(run, problemOf(r), r.detail);
        return;
      case "auth":
      case "blocked":
      case "rejected":
        // Waiting does not fix a token, a firewall rule, or an address that is not the page.
        this.hold(run, problemOf(r), r.detail);
        return;
      default:
        this.failed(run, item, problemOf(r), r.detail);
    }
  }

  private succeeded(run: Run, item: string): void {
    run.lastSentAt = Date.now();
    this.everSent = true;
    if (!run.delivered) {
      run.delivered = true;
      console.log("[publish] the page accepted the first request");
    }
    run.failures.delete(item);
    // The problem ends when the request that caused it goes through, not when something lighter does.
    if (run.failures.size === 0 && run.problem) this.recover(run);
    if (!run.problem) {
      const decision = run.outage.ok("page", Date.now());
      if (decision.log) console.log(`[publish] reaching the page again${scrub(decision.note)}`);
    }
  }

  /** Every failing request has gone through, or is no longer wanted. */
  private recover(run: Run): void {
    run.failures.clear();
    run.problem = null;
    run.retryAt = 0;
    if (run.retryTimer) clearTimeout(run.retryTimer);
    run.retryTimer = null;
  }

  /** A failure waiting can fix: back off, say so once, and probe with a heartbeat when the wait is over. */
  private failed(run: Run, item: string, problem: PublishProblem, detail?: string): void {
    run.failures.set(item, (run.failures.get(item) ?? 0) + 1);
    run.cycleFailed = true;
    run.problem = problem;
    // By the request that has failed the most, so a heartbeat that goes through cannot shorten the wait for the one that has not.
    const wait = backoffMs(Math.max(...run.failures.values()), this.timings.backoffMinMs, this.timings.backoffMaxMs);
    run.retryAt = Date.now() + wait;
    const decision = run.outage.fail("page", `${problem.kind}:${problem.status ?? ""}`, Date.now());
    if (decision.log) {
      console.warn(`[publish] the page is not accepting what is sent — ${scrub(failureForLog(problem.message, detail), FAILURE_LOG_MAX)} Trying again in ${scrub(Math.round(wait / 1000))} s${scrub(decision.note)}`);
    }
    if (run.retryTimer) clearTimeout(run.retryTimer);
    run.retryTimer = setTimeout(() => void this.probe(run), wait);
    run.retryTimer.unref?.();
  }

  /** A failure waiting cannot fix: stop until the settings change. The card keeps reading the problem off the run. */
  private hold(run: Run, problem: PublishProblem, detail?: string): void {
    this.teardown(run);
    run.held = problem;
    const decision = run.outage.fail("page", `${problem.kind}:${problem.status ?? ""}`, Date.now());
    if (decision.log) {
      console.warn(`[publish] publishing is held — ${scrub(failureForLog(problem.message, detail), FAILURE_LOG_MAX)} Change the address or the token to try again.${scrub(decision.note)}`);
    }
  }

  /** After a wait: the lightest request there is. It says the page is there, and lets the cycles start again; it ends nothing. */
  private async probe(run: Run): Promise<void> {
    if (this.run !== run || run.held) return;
    run.retryAt = 0;
    const r = await this.beat(run);
    if (r.ok) run.ticker?.arm(0);
  }

  private beat(run: Run): Promise<PushResult> {
    return this.send(run, "heartbeat", (c) => c.heartbeat(Date.now(), this.deps.version()));
  }

  // ── The cycle ──────────────────────────────────────────────────────────────

  /** One full pass. Public for tests; the timer is what runs it. */
  async runCycle(): Promise<void> {
    await this.run?.ticker?.run();
  }

  private async cycle(run: Run): Promise<CycleOutcome> {
    if (this.run !== run || run.cycling || this.blocked(run)) return "skip";
    run.cycling = true;
    run.nudged = false;
    run.cycleFailed = false;
    try {
      if (!(await this.checkIn(run))) return "skip";
      await this.localDocs(run);
      if (this.alive(run)) await this.planningCenterDocs(run);
      if (this.alive(run)) await this.publishFrames(run);
      if (this.alive(run)) await this.syncAssets(run);
      if (this.alive(run)) await this.sendManifest(run);
      if (this.alive(run)) void this.trickleRun(run);
      // A pass with nothing failing has retried everything that was, so what is still counted as failing is no longer wanted.
      if (this.alive(run) && !run.cycleFailed && run.failures.size > 0) this.recover(run);
      return "done";
    } finally {
      run.cycling = false;
    }
  }

  /** What is asked of the page first: who it is, the first time, and what it holds, now and then. False when it did not answer. */
  private async checkIn(run: Run): Promise<boolean> {
    if (!run.verified) return this.verify(run);
    if (Date.now() - run.lastReconcileAt >= this.timings.reconcileMs) return this.reconcile(run);
    return true;
  }

  /** The page's account of itself, in line with every other request. Null when there is no usable answer, which the failure handling has already dealt with. */
  private async askPage(run: Run): Promise<PageStatus | null> {
    const r = await this.send(run, "status", (c) => c.status());
    // Another protocol is a page this server's own Worker would fix: the deployer decides whether to put it there.
    if (!r.ok && r.kind === "protocol" && r.pageBuild !== undefined && this.run === run) this.deps.deploy?.consider(r.pageBuild);
    return r.ok && r.page ? r.page : null;
  }

  /** Once per run: is this address the page, and does it speak our protocol? */
  private async verify(run: Run): Promise<boolean> {
    const page = await this.askPage(run);
    if (!page) return false;
    run.verified = true;
    run.lastReconcileAt = Date.now();
    run.pageHolds = page;
    this.deps.deploy?.consider(page.build);
    // First contact: the page hears from this server before it is sent a document, so the bar that says the church has not been heard from does not wait out a heartbeat interval.
    await this.beat(run);
    return true;
  }

  /**
   * Ask the page what it holds and forget having sent whatever it does not. A page that lost its
   * store (a redeploy that changed its storage, a manifest somebody sent by hand) would otherwise
   * stay empty for good: a document here is sent only when its text changes.
   */
  private async reconcile(run: Run): Promise<boolean> {
    run.lastReconcileAt = Date.now();
    const page = await this.askPage(run);
    if (!page) return false;
    run.pageHolds = page;
    this.deps.deploy?.consider(page.build);
    const heldDocs = new Set(page.docs);
    const heldAssets = new Set(page.assets);
    const lostDocs = [...run.sent.keys()].filter((key) => !heldDocs.has(key));
    const lostAssets = [...run.assets.sent].filter((name) => !heldAssets.has(name));
    for (const key of lostDocs) {
      run.sent.delete(key);
      // Due again at once, so a lost rundown comes back with the next trickle.
      run.nextDue.delete(key);
    }
    for (const name of lostAssets) run.assets.sent.delete(name);
    if (lostDocs.length + lostAssets.length > 0) {
      console.warn(`[publish] the page no longer holds ${scrub(plural(lostDocs.length, "document"))} and ${scrub(plural(lostAssets.length, "image"))} sent to it; sending again`);
    }
    return true;
  }

  /**
   * What one read said: its value, or why there is none. Said once per outage; the page keeps the last copy of what could not be
   * read. `failure` is for an answer that is a failure in disguise: the app serves its last list with the reason it could not refresh it.
   */
  private async read<T>(run: Run, what: string, fn: () => Promise<T>, failure?: (value: T) => string | undefined): Promise<ReadResult<T>> {
    let reason: string | undefined;
    let value: T | undefined;
    try {
      value = await fn();
      reason = failure?.(value);
    } catch (err) {
      reason = errorMessage(err);
    }
    if (reason === undefined) {
      run.outage.forget(`read:${what}`);
      return { ok: true, value: value as T };
    }
    const note = this.news(run, `read:${what}`, reason);
    if (note !== null) console.warn(`[publish] could not read ${scrub(what)}: ${scrub(reason)}; the page keeps its last copy${scrub(note)}`);
    return { ok: false, reason };
  }

  /** A read from Planning Center, for the document `key`: as `read`, and remembered for the card's source problem. */
  private async pcoRead<T>(run: Run, key: string, what: string, fn: () => Promise<T>, failure?: (value: T) => string | undefined): Promise<ReadResult<T>> {
    const r = await this.read(run, what, fn, failure);
    if (r.ok) this.sourceRead(run, key);
    else run.sourceFailures.set(key, r.reason);
    return r;
  }

  /** The document `key` was read from Planning Center. */
  private sourceRead(run: Run, key: string): void {
    if (!run.sourceFailures.delete(key)) return;
    // Said for what the page still wants: a plan that failed and then left the switcher is no reason to stay quiet.
    if (this.sourceProblem(run) === null) {
      console.log("[publish] Planning Center can be read again");
      return;
    }
    // It answers again, so what else failed is due at the next trickle, not after its retry wait: until then the card says it can't be read.
    for (const other of run.sourceFailures.keys()) run.nextDue.delete(other);
  }

  /** `key` has failed with `kind`: the text to append if that is news (the first time, a new kind, a reminder), null while it is the same failure again. */
  private news(run: Run, key: string, kind: string): string | null {
    const decision = run.outage.fail(key, kind, Date.now());
    return decision.log ? decision.note : null;
  }

  /** Put a document, unless its text is what the page already has. */
  private async put(run: Run, key: string, text: string): Promise<boolean> {
    const hash = docHash(text);
    const already = () => run.sent.get(key) === hash || run.refused.get(key) === hash;
    const r = await this.send(run, `doc:${key}`, (c) => c.putDoc(key, text), already);
    if (r === UNCHANGED) return true;
    if (r.ok) {
      run.sent.set(key, hash);
      run.refused.delete(key);
      return true;
    }
    if (r.kind === "refused") {
      // Remembered by its text, so it is not tried again until it changes.
      run.refused.set(key, hash);
      console.warn(`[publish] not sent: ${scrub(key)}, and not tried again until it changes — ${scrub(failureForLog(r.message, r.detail), FAILURE_LOG_MAX)}`);
    }
    return false;
  }

  private async localDocs(run: Run): Promise<void> {
    const { source } = this.deps;
    const [config, layouts, roles] = await Promise.all([
      this.read(run, "the landing page settings", () => source.config()),
      this.read(run, "the layouts", () => source.layouts()),
      this.read(run, "the category roles", () => source.roles()),
    ]);
    if (config.ok) {
      run.known.landingIds = landingTypeIds(config.value);
      run.haveConfig = true;
      await this.put(run, "servicecue-config", JSON.stringify(config.value));
    }
    if (layouts.ok) {
      run.counts.layouts = layouts.value.length;
      await this.put(run, "servicecue-layouts", JSON.stringify(layouts.value));
    }
    if (roles.ok) await this.put(run, "servicecue-roles", JSON.stringify(roles.value));
    run.known.pcoConfigured = !!source.state().pcoConfigured;
  }

  private async planningCenterDocs(run: Run): Promise<void> {
    const { source } = this.deps;
    if (!run.known.pcoConfigured) {
      // Nothing to read, and the page will not ask: it checks the same flag.
      run.known.plans = [];
      run.counts.types = 0;
      return;
    }
    const now = Date.now();
    const due = run.forcePco || !source.dormant() || now - run.lastPcoAt >= this.timings.dormantRefreshMs;
    if (!due || !this.pcoClear(run)) return;
    run.forcePco = false;

    const ids = run.known.landingIds;
    const types = await this.pcoRead(run, "service-types", "the service types", () => source.serviceTypes());
    if (types.ok) {
      const shown = landingTypes(types.value, ids);
      run.counts.types = shown.length;
      await this.put(run, "service-types", JSON.stringify(shown));
    }
    // The app serving its last list with the reason it could not refresh it is a failed read: its complaint is not for the page, and the last good list stays.
    const upcoming = await this.pcoRead(run, "plans-upcoming", "the plan list", () => source.upcoming(PUBLISH_UPCOMING_DAYS), (list) => list.unavailable);
    if (upcoming.ok) {
      run.known.plans = mergePlans(run.known.plans, upcoming.value, ids, startOfToday(source.timeZone()));
      run.havePlans = true;
      run.incompleteTypes = upcoming.value.incompleteTypeIds ?? [];
      run.lastPcoAt = now;
      await this.put(run, "plans-upcoming", this.plansDoc(run));
    }

    // The rundown each type opens on, and the same plan under its own key: the page asks for it that way once somebody picks it in the switcher.
    run.currentKeys.clear();
    for (const id of ids) {
      if (!this.alive(run) || !this.pcoClear(run)) return;
      const typeKey = rundownKey(id);
      if (typeKey === null) continue;
      const r = await this.pcoRead(run, typeKey, `the rundown for service type ${id}`, () => source.rundown(id, null));
      if (!r.ok) continue;
      await this.put(run, typeKey, JSON.stringify(r.value));
      const planId = r.value.planId;
      const planKey = planId ? rundownKey(id, planId) : null;
      if (planKey !== null && this.plansOf(run).some((p) => p.serviceTypeId === id && p.planId === planId)) {
        run.currentKeys.add(planKey);
        // The one read is that plan's too, which a trickle that failed it is waiting to retry.
        this.sourceRead(run, planKey);
        run.nextDue.set(planKey, Date.now() + this.slowEveryMs());
        await this.put(run, planKey, JSON.stringify(r.value));
      }
    }
  }

  /** The plans the page is offered: the ones it has been given, of the types still on the landing page. */
  private plansOf(run: Run) {
    return run.known.plans.map((k) => k.plan).filter((p) => run.known.landingIds.includes(p.serviceTypeId));
  }

  private plansDoc(run: Run): string {
    const state = this.deps.source.state();
    return JSON.stringify(upcomingDoc(this.plansOf(run), { typeId: state.serviceTypeId ?? null, planId: state.planId ?? null }));
  }

  private slowEveryMs(): number {
    return this.deps.source.dormant() ? this.timings.dormantSlowEveryMs : this.timings.slowEveryMs;
  }

  /**
   * May Planning Center be read now? False while its gate reports tight headroom.
   *
   * Said when that starts and when it ends, not every round: a hold can last the whole of a service.
   */
  private pcoClear(run: Run): boolean {
    const tight = this.deps.source.pcoTight();
    if (tight !== run.heldForPco) {
      run.heldForPco = tight;
      if (tight) console.warn("[publish] Planning Center's rate-limit headroom is tight; the rundown refresh is on hold until it clears");
      else console.warn("[publish] Planning Center's rate-limit headroom has recovered; the rundown refresh is running again");
    }
    return !tight;
  }

  /**
   * The other plans in the switcher: one at a time, a gap between, each no more often than every
   * `slowEveryMs` (hours, between the service windows). A plan the page has never been given is due at once.
   */
  trickle(): Promise<void> {
    return this.run ? this.trickleRun(this.run) : Promise.resolve();
  }

  /** A pass already under way is joined, not doubled: two would read at once. */
  private trickleRun(run: Run): Promise<void> {
    if (run.trickling) return run.trickling;
    const pass: Promise<void> = this.trickleNow(run).finally(() => {
      if (run.trickling === pass) run.trickling = null;
    });
    run.trickling = pass;
    return pass;
  }

  private async trickleNow(run: Run): Promise<void> {
    for (const plan of this.plansOf(run)) {
      if (!this.alive(run)) return;
      const key = rundownKey(plan.serviceTypeId, plan.planId);
      if (key === null || run.currentKeys.has(key) || (run.nextDue.get(key) ?? 0) > Date.now()) continue;
      if (!this.pcoClear(run)) return;
      const r = await this.pcoRead(run, key, `the rundown for plan ${plan.planId}`, () => this.deps.source.rundown(plan.serviceTypeId, plan.planId));
      run.nextDue.set(key, Date.now() + (r.ok ? this.slowEveryMs() : this.timings.failRetryMs));
      if (r.ok) await this.put(run, key, JSON.stringify(r.value));
      await this.pause(run, this.timings.staggerMs);
    }
  }

  /** A wait that ends early if the run is stopped. */
  private pause(run: Run, ms: number): Promise<void> {
    const { signal } = run.abort;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
    });
  }

  // ── Images ─────────────────────────────────────────────────────────────────

  private wantedAssets(): string[] {
    const name = brandingAssetName(this.deps.source.state().appLogo);
    return name ? [name] : [];
  }

  private async syncAssets(run: Run): Promise<void> {
    const wanted = this.wantedAssets();
    // A refusal is remembered by name, and forgotten once the logo is another file.
    for (const name of [...run.assets.refused]) if (!wanted.includes(name)) run.assets.refused.delete(name);
    for (const name of wanted) {
      if (run.assets.sent.has(name) || run.assets.refused.has(name) || !this.alive(run)) continue;
      let image: { data: Uint8Array; mime: string } | null;
      try {
        image = await this.deps.source.brandingImage(name);
        run.outage.forget("read:logo");
      } catch (err) {
        const note = this.news(run, "read:logo", errorMessage(err));
        if (note !== null) console.warn(`[publish] could not read the logo ${scrub(name)}: ${scrub(errorMessage(err))}; the page keeps what it has${scrub(note)}`);
        continue;
      }
      if (!image) continue;
      if (assetContentType(image.mime) === null) {
        run.assets.refused.add(name);
        console.warn(`[publish] the logo ${scrub(name)} is ${scrub(image.mime)}, a type the page does not take; it is left off the page`);
        continue;
      }
      const r = await this.send(run, `asset:${name}`, (c) => c.putAsset(name, image.data, image.mime), () => run.assets.sent.has(name));
      if (r.ok) {
        run.assets.sent.add(name);
      } else if (r.kind === "refused") {
        run.assets.refused.add(name);
        console.warn(`[publish] not sent: the logo ${scrub(name)}, and it is left off the page — ${scrub(failureForLog(r.message, r.detail), FAILURE_LOG_MAX)}`);
      }
    }
  }

  // ── The manifest ───────────────────────────────────────────────────────────

  /** Everything the plan list, the landing page settings and the page's own fixed keys have been read for. */
  private ready(run: Run): boolean {
    return run.haveConfig && (!run.known.pcoConfigured || run.havePlans);
  }

  /**
   * Every document the page should hold, whether or not it has been sent this run: all the contract's
   * fixed keys (so one added to it cannot be deleted by the manifest for being forgotten here), less the
   * two that need Planning Center while it is not connected, and a rundown for each landing type and each plan offered.
   */
  private wantedDocs(run: Run): string[] {
    const keys = new Set<string>(FIXED_DOC_KEYS);
    if (!run.known.pcoConfigured) {
      keys.delete("service-types");
      keys.delete("plans-upcoming");
    } else {
      const rundowns = [...run.known.landingIds.map((id) => rundownKey(id)), ...this.plansOf(run).map((p) => rundownKey(p.serviceTypeId, p.planId))];
      for (const key of rundowns) if (key !== null) keys.add(key);
    }
    return [...keys].sort();
  }

  /**
   * Tell the page exactly what to keep. It deletes the rest, which is how a type taken off the
   * landing page, or a plan that has gone by, leaves the public site.
   *
   * Not before everything it names has been read this run: one made without it would name too
   * little, and a restart during a Planning Center outage must not take the plans off the page. And
   * only when it would change something: what it names is not what was last sent, or the last status
   * showed the page holding what it does not name.
   */
  private async sendManifest(run: Run): Promise<void> {
    if (!this.ready(run)) return;
    // A type the plan list could not read in full, and of which this run knows no plan, has plans the page may hold
    // that this run cannot name: a restart during a partial outage. A list made now would delete them.
    const unknown = run.incompleteTypes.filter((id) => run.known.landingIds.includes(id) && !run.known.plans.some((k) => k.plan.serviceTypeId === id));
    if (unknown.length > 0) {
      const note = this.news(run, "manifest-hold", unknown.join(","));
      if (note !== null) console.warn(`[publish] the plan list could not be read in full for service type ${scrub(unknown.join(", "))}; the list of what to keep waits, so the plans the page holds for it stay${scrub(note)}`);
      return;
    }
    run.outage.forget("manifest-hold");
    const docs = this.wantedDocs(run);
    const assets = this.wantedAssets();
    const key = JSON.stringify([docs, assets]);
    const extras = !!run.pageHolds && (run.pageHolds.docs.some((d) => !docs.includes(d)) || run.pageHolds.assets.some((a) => !assets.includes(a)));
    if (key === run.manifestKey && !extras) return;
    const r = await this.send(run, "manifest", (c) => c.putManifest(docs, assets));
    if (!r.ok) {
      // A manifest the page will not take is not something a retry changes, and it would be said every cycle.
      const note = r.kind === "refused" ? this.news(run, "manifest", `${r.status ?? ""}`) : null;
      if (note !== null) console.warn(`[publish] the page refused the list of what to keep — ${scrub(failureForLog(r.message, r.detail), FAILURE_LOG_MAX)} Nothing is removed from the page until it takes one${scrub(note)}`);
      return;
    }
    run.outage.forget("manifest");
    run.manifestKey = key;
    run.pageHolds = null;
    // What the page dropped is no longer held, so it is sent afresh if it is ever wanted again; and its schedule goes with it.
    for (const doc of [...run.sent.keys()]) if (!docs.includes(doc)) run.sent.delete(doc);
    for (const doc of [...run.nextDue.keys()]) if (!docs.includes(doc)) run.nextDue.delete(doc);
    // And its failure: a plan that comes back is not shown as failing before it has been read again.
    for (const doc of [...run.sourceFailures.keys()]) if (!docs.includes(doc)) run.sourceFailures.delete(doc);
    for (const name of [...run.assets.sent]) if (!assets.includes(name)) run.assets.sent.delete(name);
    // The page's own account of what it deleted: the evidence that a type or a plan that left the landing page has left the public one.
    const removed = r.removed;
    if (removed && removed.docs.length + removed.assets.length > 0) {
      console.log(`[publish] the page removed ${scrub(plural(removed.docs.length, "document"))} and ${scrub(plural(removed.assets.length, "image"))} that are no longer wanted`);
    }
  }

  // ── The live channels ──────────────────────────────────────────────────────

  /**
   * The app broadcast on a channel: fold it into the next flush, at most one a second. What goes out is
   * read from the app at that point, not taken from the payload, so a burst is one frame carrying the
   * last value, and a rebroadcast of an old record (a history edit) cannot be forwarded as the live one.
   */
  private onBroadcast(channel: string): void {
    const run = this.run;
    if (!run || run.held || !isFrameChannel(channel)) return;
    run.pending.add(channel);
    // Every state broadcast may have moved the followed plan, which is what decides whether the live channels are public at all.
    if (channel === "stage:state-changed") for (const c of FRAME_ORDER) run.pending.add(c);
    if (run.flushTimer) return;
    const wait = Math.max(0, run.lastFlushAt + this.timings.frameMs - Date.now());
    run.flushTimer = setTimeout(() => {
      run.flushTimer = null;
      void this.flush();
    }, wait);
    run.flushTimer.unref?.();
  }

  /** Send every channel that has something new, after any flush already under way. Public for tests, which wait on it. */
  flush(): Promise<void> {
    const run = this.run;
    if (!run) return Promise.resolve();
    const next = run.flushing.then(() => this.flushNow(run));
    run.flushing = next.catch(() => undefined);
    return next;
  }

  private async flushNow(run: Run): Promise<void> {
    run.lastFlushAt = Date.now();
    const channels = FRAME_ORDER.filter((c) => run.pending.has(c));
    run.pending.clear();
    for (const channel of channels) await this.publishFrame(run, channel);
  }

  private async publishFrames(run: Run): Promise<void> {
    for (const channel of FRAME_ORDER) await this.publishFrame(run, channel);
  }

  /** Is this plan one the page is offered, of a type on the landing page? Nothing else's live position or SPL is the page's to see. */
  private publishes(run: Run, typeId: string | null | undefined, planId: string | null | undefined): boolean {
    return !!typeId && !!planId && this.plansOf(run).some((p) => p.serviceTypeId === typeId && p.planId === planId);
  }

  /** What a channel should say now: the public part of the state, or of the live position or SPL recording of a plan the page is offered, or null. */
  private frameData(run: Run, channel: FrameChannel): PublicState | PublicLive | PublicSpl | null {
    const { source } = this.deps;
    switch (channel) {
      case "stage:state-changed":
        return publicState(source.state(), source.timeZone());
      case "pco:live": {
        const live = source.live();
        const followed = source.state();
        return live && this.publishes(run, followed.serviceTypeId, followed.planId) ? publicLive(live) : null;
      }
      case "spl:history": {
        const recording = source.spl();
        return recording && this.publishes(run, recording.serviceTypeId, recording.planId) ? publicSpl(recording) : null;
      }
      default: {
        // A channel the contract lists and this does not handle fails to COMPILE here, rather than being heard and quietly dropped.
        const unhandled: never = channel;
        return unhandled;
      }
    }
  }

  /**
   * One channel, as a frame for the viewers connected now. The page stores a frame's data as the document it
   * belongs to (FRAME_DOCS), so the frame is also the document: it is not sent a second time as one, and the
   * document counts as held once the frame is accepted. The state's logo is sent first: a page told of a new
   * logo before it holds the file draws a broken image, and an image does not ask again.
   *
   * Not before what is public is known (the live channels), not when what it would say is what the page
   * already has (a keepalive that moved only the clock), and not again after the page refused it: that would
   * be refused again. A refusal is said once, until the page takes a frame again.
   */
  private async publishFrame(run: Run, channel: FrameChannel): Promise<void> {
    const doc = FRAME_DOCS.get(channel);
    if (!doc || !this.alive(run)) return;
    if (channel !== "stage:state-changed" && !this.ready(run)) return;
    if (channel === "stage:state-changed") await this.syncAssets(run);
    const data = this.frameData(run, channel);
    const hash = docHash(channel === "pco:live" && data ? liveFingerprint(data as PublicLive) : JSON.stringify(data));
    const already = () => run.sent.get(doc) === hash || run.refused.get(doc) === hash;
    const r = await this.send(run, `frame:${channel}`, (c) => c.postFrame(channel, data), already);
    if (r === UNCHANGED) return;
    if (r.ok) {
      run.sent.set(doc, hash);
      run.refused.delete(doc);
      run.outage.forget(`frame:${channel}`);
    } else if (r.kind === "refused") {
      run.refused.set(doc, hash);
      const note = this.news(run, `frame:${channel}`, `${r.status ?? ""}`);
      if (note !== null) console.warn(`[publish] the page refused a ${scrub(channel)} frame — ${scrub(failureForLog(r.message, r.detail), FAILURE_LOG_MAX)}${scrub(note)}`);
    }
  }

  // ── Leaving a page ─────────────────────────────────────────────────────────

  /**
   * Ask the page being left to forget everything it holds: a manifest that lists nothing. What switching
   * publishing off means is that the rundown stops being public, and a page left holding its last copy until
   * somebody deletes it is not that. The answer goes back to the caller, so a page that could not be reached,
   * or a server that has no token for it any more, is told to the operator rather than assumed gone.
   */
  private async dropOldCopy(target: Target | null): Promise<DropResult> {
    if (!target) {
      // Never started here (a restored backup, no token): this process sent nothing, so there is nothing to say.
      if (!this.everSent) return { ok: true };
      return { ok: false, message: "This server was not connected to the page, so it could not ask it to forget its copy. The page may still hold the last rundown it was sent." };
    }
    const r = await createPushClient({ origin: target.origin, token: target.token }).putManifest([], []);
    if (r.ok) {
      console.log("[publish] asked the page to drop its copy");
      return { ok: true };
    }
    console.warn(`[publish] the page could not be asked to drop its copy — ${scrub(failureForLog(r.message, r.detail), FAILURE_LOG_MAX)}`);
    return { ok: false, message: r.message };
  }
}
