// probe-scheduler.ts — when to ask each pulled camera to describe its stream.
//
// Probes cost the camera a connection and a few hundred bytes, so they run only
// while something is looking at the answer: a client subscribed to
// `video:probe` (the Video feeds page, nothing else). Every PROBE_INTERVAL_MS
// while watched, and once at once on the first subscriber.
//
// What it does not ask about:
//  - a feed the relay already reports ready: the relay's own word is better;
//  - a feed the relay was asked for a moment ago and may be dialling: some
//    encoders answer one DESCRIBE at a time, so ours would read as busy;
//  - any feed while the Video feeds switch is off;
//  - an SRT feed, which cannot be asked without streaming it.
//
// Results live in a Map and publish as one `video:probe` snapshot on every
// answer, so a new `checkedAt` reaches the page too. The scheduler holds no
// store and writes no log; what to say about an answer is the owner's
// `onResult`, so the log shares the relay dial's one-line-per-outage rule.

import type { VideoFeed, VideoProbeEntry, VideoProbeState } from "../../types/video.js";
import { InFlight } from "./in-flight.js";
import { probeKind, type ProbeResult, type ProbeTarget } from "./probe.js";

/** How often every pulled feed is asked, while watched. */
export const PROBE_INTERVAL_MS = 15_000;

export interface ProbeSchedulerDeps {
  /** Is a client subscribed to `video:probe`? */
  inDemand: () => boolean;
  /** The Video feeds switch. */
  isEnabled: () => boolean;
  loadFeeds: () => Promise<readonly VideoFeed[]>;
  /** A feed's stored login password, or undefined. */
  getPassword: (feedId: string) => Promise<string | undefined>;
  /** Does the relay report this feed ready (live or delayed) right now? */
  isReady: (feedId: string) => boolean;
  /** Was the relay asked for this feed recently, so it may be dialling it now? */
  isDialling: (feedId: string) => boolean;
  probe: (target: ProbeTarget) => Promise<ProbeResult>;
  /** Send the snapshot to the channel. */
  publish: (state: VideoProbeState) => void;
  /** A real answer for a feed (never "unchecked", never a stale one). */
  onResult: (feed: VideoFeed, result: ProbeResult, now: number) => void;
  /** A round that could not run at all (the feed list would not load). */
  onRoundError: (err: unknown) => void;
  /** A round that ran to the end without failing. */
  onRoundOk: () => void;
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (t: NodeJS.Timeout) => void;
  now: () => number;
}

/** Was a feed asked with this address and login both times? */
function sameTarget(a: ProbeTarget | undefined, b: ProbeTarget): boolean {
  return a !== undefined && a.url === b.url && a.username === b.username && a.password === b.password;
}

type RevisionSnapshot = { global: number; feeds: ReadonlyMap<string, number> };

export class ProbeScheduler {
  private readonly results = new Map<string, VideoProbeEntry>();
  /** The address and login each result was got with. A change resets it. */
  private readonly targets = new Map<string, ProbeTarget>();
  /** The probe each feed is being asked right now, by what it was asked with.
   *  A second round (watching stopped and started again within a probe's
   *  length, which a page connecting does) joins it instead of asking the
   *  camera again: some cameras answer a DESCRIBE made while another is open
   *  with 406, which would read as Not answering. */
  private readonly inFlight = new Map<string, { target: ProbeTarget; promise: Promise<ProbeResult> }>();
  private timer: NodeJS.Timeout | null = null;
  /** Bumped when watching stops: an answer from before it is dropped. */
  private generation = 0;
  /** The generation a round is running for, or null. */
  private roundGeneration: number | null = null;
  /** Bumped when a feed is added, edited or removed (per feed), or when the
   *  switch moves or an import changes many (the global one). An answer from a
   *  round that began before the bump may be about a feed that is gone or has
   *  a new address, so it is dropped; the round queued by the change asks
   *  afresh. Per feed, so editing one camera does not throw away the answers
   *  of the others and ask them all again. */
  private globalRevision = 0;
  private readonly feedRevisions = new Map<string, number>();
  /** Feeds a change asked to be re-checked at once, or every feed. */
  private pending: Set<string> | "all" | null = null;
  /** Every round started and not yet finished, for whenIdle(). A stale
   *  generation's round can still be running beside a newer one's. */
  private readonly rounds = new InFlight();

  constructor(private readonly deps: ProbeSchedulerDeps) {}

  current(): VideoProbeState {
    return { feeds: Object.fromEntries(this.results), at: this.deps.now() };
  }

  /** Start or stop from demand as it stands. Call on every subscription change. */
  subscriptionsChanged(): void {
    if (this.deps.inDemand()) this.start();
    else this.stop();
  }

  /** A feed was added, edited or removed: do not wait for the next tick. With
   *  no id, every feed (an import changes many). */
  feedsChanged(feedId?: string): void {
    if (!this.timer) return;
    if (feedId === undefined) {
      this.globalRevision++;
      this.pending = "all";
    } else {
      this.feedRevisions.set(feedId, (this.feedRevisions.get(feedId) ?? 0) + 1);
      if (this.pending === null) this.pending = new Set();
      if (this.pending !== "all") this.pending.add(feedId);
    }
    if (this.roundGeneration !== this.generation) this.runPending();
  }

  /** The Video feeds switch moved. */
  switchChanged(): void {
    this.feedsChanged();
  }

  private runPending(): void {
    const only = this.pending;
    this.pending = null;
    this.runRound(only === "all" ? undefined : (only ?? undefined));
  }

  private start(): void {
    if (this.timer) return;
    this.timer = this.deps.setInterval(() => this.runRound(), PROBE_INTERVAL_MS);
    this.runRound();
  }

  private stop(): void {
    if (!this.timer) return;
    this.deps.clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    this.pending = null;
    this.feedRevisions.clear();
    // What was learned describes a page that is gone; the next one starts at
    // "checking", never at a result from an hour ago.
    const hadResults = this.results.size > 0;
    this.results.clear();
    this.targets.clear();
    if (hadResults) this.deps.publish(this.current());
  }

  /** One round: every pulled feed, or only `only` (a nudge for a changed one). */
  private runRound(only?: ReadonlySet<string>): void {
    const generation = this.generation;
    if (this.roundGeneration === generation) return;
    this.roundGeneration = generation;
    const seen = { global: this.globalRevision, feeds: new Map(this.feedRevisions) };
    void this.rounds.track(
      this.round(generation, seen, only)
        .then(() => this.deps.onRoundOk())
        .catch((err: unknown) => this.deps.onRoundError(err))
        .finally(() => {
          if (this.roundGeneration === generation) this.roundGeneration = null;
          if (this.pending && this.timer && this.generation === generation) this.runPending();
        }),
    );
  }

  /** Resolves once no round is running, including one a finishing round
   *  started for a change that landed while it ran. For the caller that needs
   *  a round nobody handed it the promise of (every trigger starts one
   *  unawaited) to have landed. No count of event-loop turns can say that: a
   *  round reads the feed file and each camera's password, and a disk read
   *  takes however many turns the machine's load makes it. */
  whenIdle(): Promise<void> {
    return this.rounds.whenIdle();
  }

  /** Has this feed (or anything) changed since a round took its `seen` snapshot? */
  private changedSince(id: string, seen: { global: number; feeds: ReadonlyMap<string, number> }): boolean {
    return seen.global !== this.globalRevision || (seen.feeds.get(id) ?? 0) !== (this.feedRevisions.get(id) ?? 0);
  }

  private async round(generation: number, seen: RevisionSnapshot, only?: ReadonlySet<string>): Promise<void> {
    const feeds = (await this.deps.loadFeeds()).filter((f) => f.source.kind === "pull");
    if (generation !== this.generation) return;

    const ids = new Set(feeds.map((f) => f.id));
    let changed = false;
    for (const id of [...this.results.keys()]) {
      if (ids.has(id)) continue;
      this.results.delete(id);
      this.targets.delete(id);
      changed = true;
    }
    if (!this.deps.isEnabled()) {
      // Off: nothing is asked, and nothing is claimed about any feed.
      if (this.results.size > 0) {
        this.results.clear();
        this.targets.clear();
        changed = true;
      }
      if (changed) this.deps.publish(this.current());
      return;
    }
    if (changed) this.deps.publish(this.current());
    await Promise.all(feeds.filter((f) => !only || only.has(f.id)).map((feed) => this.check(feed, generation, seen)));
  }

  private async check(feed: VideoFeed, generation: number, seen: RevisionSnapshot): Promise<void> {
    if (feed.source.kind !== "pull") return;
    const id = feed.id;
    // The relay's own reading is better than ours; the old entry waits, unseen
    // (Live wins on the page), until the feed stops being ready.
    if (this.deps.isReady(id)) return;
    // Nor while the relay may be dialling it: one DESCRIBE at a time on some
    // encoders, and the relay's dial is the one that matters.
    if (this.deps.isDialling(id)) return;

    const target: ProbeTarget = {
      url: feed.source.url,
      username: feed.source.username,
      password: (await this.deps.getPassword(id)) ?? "",
    };
    if (generation !== this.generation) return;
    // The edit may have landed while the password read was open.
    if (this.changedSince(id, seen)) return;
    const now = this.deps.now();

    if (probeKind(target.url) === null) {
      if (!sameTarget(this.targets.get(id), target) || this.results.get(id)?.state !== "unchecked") {
        this.targets.set(id, target);
        this.results.set(id, { state: "unchecked", checkedAt: now });
        this.deps.publish(this.current());
      }
      return;
    }

    if (!sameTarget(this.targets.get(id), target)) {
      this.targets.set(id, target);
      this.results.set(id, { state: "checking", checkedAt: now });
      this.deps.publish(this.current());
    }

    const result = await this.ask(id, target);
    // Watching stopped, or a feed was added, edited or removed while this ran.
    if (generation !== this.generation || this.changedSince(id, seen) || !sameTarget(this.targets.get(id), target)) return;
    // A camera busy answering someone else is no news: keep what it showed.
    // Only a feed that has never answered says so, or it reads Checking for ever.
    if (result.state === "busy") {
      const shown = this.results.get(id);
      if (shown?.state === "checking" && !shown.busy) {
        this.results.set(id, { ...shown, busy: true });
        this.deps.publish(this.current());
      }
      return;
    }
    const answeredAt = this.deps.now();
    this.results.set(id, this.entryFor(id, result, answeredAt));
    this.deps.publish(this.current());
    this.deps.onResult(feed, result, answeredAt);
  }

  private ask(id: string, target: ProbeTarget): Promise<ProbeResult> {
    const joined = this.inFlight.get(id);
    if (joined && sameTarget(joined.target, target)) return joined.promise;
    const promise = this.deps.probe(target).finally(() => {
      if (this.inFlight.get(id)?.promise === promise) this.inFlight.delete(id);
    });
    this.inFlight.set(id, { target, promise });
    return promise;
  }

  private entryFor(id: string, result: ProbeResult, checkedAt: number): VideoProbeEntry {
    if (result.state === "ready") {
      const entry: VideoProbeEntry = { state: "ready", checkedAt };
      if (result.codec) entry.codec = result.codec;
      if (result.width && result.height) {
        entry.width = result.width;
        entry.height = result.height;
      }
      return entry;
    }
    if (result.state === "failed") {
      const before = this.results.get(id);
      return { state: "failed", reason: result.reason, checkedAt, since: before?.state === "failed" ? (before.since ?? before.checkedAt) : checkedAt };
    }
    return { state: "unchecked", checkedAt };
  }
}
