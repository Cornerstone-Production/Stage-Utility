// main/services/video/video-service.ts — feeds, their status and the relay.
//
// The one owner of `video:state`. Every change goes through here and ends in
// publish(), so the page, every widget and the hello burst see one snapshot.

import { EventEmitter } from "node:events";

import { addSubscriptionListener, broadcast, channelInDemand } from "../broadcaster.js";
import { errorMessage } from "../errors.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import { secretsStore } from "../secrets.js";
import { walkLayoutObjects } from "../view-refs.js";
import { viewsStore } from "../views-store.js";
import { embedSrc } from "./embed.js";
import { FEED_ID_PATTERN, feedIdFor } from "./feed-id.js";
import { feedState, type BFramesMark } from "./feed-state.js";
import { externalProtocol, parseFeedInput } from "./feed-input.js";
import { loadFeedsFile, videoFeedsStore } from "./feed-store.js";
import { RelayLogWatcher } from "./relay-log.js";
import type { RelayPath, VideoRelay } from "./relay.js";
import { flushSeen, forgetSeen, lastSeenAt, loadSeen, noteSeen } from "./seen-store.js";
import type { SupervisorStatus } from "./supervisor.js";
import type {
  FeedPlay,
  FeedState,
  FeedStatus,
  RelayStatus,
  VideoFeed,
  VideoFeedsFile,
  VideoFeedView,
  VideoPorts,
  VideoSourceKind,
  VideoState,
} from "../../types/video.js";

type Result = { ok: true; feed: VideoFeedView } | { ok: false; error: string };

export const SECRET_SLOT = (feedId: string) => `video:${feedId}`;

/** How often relay.status() is polled while something watches `video:state`. */
export const STATUS_POLL_MS = 3000;
/** How long a WHEP/HLS request against a pull feed keeps its status reading
 *  "offline" (rather than "standby") once the relay reports it not ready —
 *  see feed-state.ts's `recentlyRequested`. */
export const RECENT_REQUEST_MS = 15_000;

/**
 * The slice of RelaySupervisor the service needs: an EventEmitter for its
 * "line" events, plus its own status()/version(). A real RelaySupervisor
 * (supervisor.ts) satisfies this structurally with no cast; a test hands in a
 * bare EventEmitter with the two methods added, per task 12's brief.
 */
export interface RelaySupervisorLike extends EventEmitter {
  status(): SupervisorStatus;
  version(): string | null;
}

/**
 * The status poll's timer, injected — the same seam cue-live.ts's
 * `cueLiveDeps` uses, for the same reason: node:test's mock.timers does not
 * drive an unref'd interval predictably, and what a test needs to assert is
 * the callback and the interval themselves, which this lets it capture
 * directly instead of waiting STATUS_POLL_MS for real.
 */
export const videoPollDeps: {
  inDemand: () => boolean;
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (t: NodeJS.Timeout) => void;
} = {
  inDemand: () => channelInDemand("video:state"),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    // A status poll must never be what keeps the process alive.
    t.unref();
    return t;
  },
  clearInterval: (t) => clearInterval(t),
};

/** The first half of each feed's source line, per kind. */
const SOURCE_LINE_KIND: Record<VideoSourceKind, string> = {
  pull: "Pulled from a device",
  push: "The device pushes",
  embed: "YouTube or Resi",
  external: "Other address",
};

/** `current.feeds`, defensively — the same reasoning loadFeedsFile applies to a
 *  disk read: a file written by an older build, or hand-restored, may carry no
 *  `feeds` array at all. */
const feedsOf = (current: VideoFeedsFile): VideoFeed[] => (Array.isArray(current.feeds) ? current.feeds : []);

/**
 * The object updateFeed re-validates a PATCH against: `existing`'s name and
 * source, each replaced by whatever the body supplies, PLUS the body's
 * `password` carried through untouched — built inline as `{ name, source }`
 * it silently dropped a pull feed's new password. Guarded through the real
 * route in video-routes.test.ts.
 */
function mergedFeedPatch(existing: VideoFeed, body: unknown): { name: unknown; source: unknown; password: unknown } {
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return {
    // Present means supplied, whatever its type: a name that is not text
    // must be refused by the name rule, not quietly replaced by the old one.
    name: "name" in obj ? obj.name : existing.name,
    source: obj.source !== undefined ? obj.source : existing.source,
    password: obj.password,
  };
}

class VideoService {
  private rev = 0;

  /**
   * The last snapshot computed by init() or publish(). writeHelloBurst is
   * SYNCHRONOUS (see remote-server.ts) and so cannot await state() the way every
   * other caller does; this is what it reads instead. Before init() has run —
   * there is no server yet to hydrate — it is the state a build with no relay
   * always starts at.
   */
  private snapshot: VideoState = {
    rev: 0,
    relay: { state: "off" },
    kinds: [...this.allowedKinds()],
    feeds: [],
  };

  // ── The relay, once task 15 attaches one ────────────────────────────────
  private relay: VideoRelay | null = null;
  private supervisor: RelaySupervisorLike | null = null;
  private lineListener: ((text: string) => void) | null = null;
  private spawnedListener: (() => void) | null = null;
  private exitListener: (() => void) | null = null;
  /** Parses the supervisor's raw stdout/stderr lines into B-frames marks.
   *  Owned here rather than read off the supervisor: supervisor.ts keeps its
   *  own copy for its own exit-reason bookkeeping, and "line" is the only
   *  parsed event it re-exports. */
  private readonly logWatcher = new RelayLogWatcher();
  /**
   * Bumped on every attachRelay()/detachRelay(). A poll captures the
   * generation it started under and checks it again after every await —
   * cheaper and more complete than comparing `this.relay` by identity, and
   * it is also what makes pollOnce()'s reentry guard per-ATTACHMENT rather
   * than global: a boolean guard here (an earlier version's design) let an
   * old relay's still-in-flight poll block the NEW relay's own first read
   * after a detach+reattach, because the boolean stayed "true" across the
   * swap. See pollingGeneration below.
   */
  private relayGeneration = 0;
  /** True while a poll for `relayGeneration` is in flight. Compared against
   *  the CURRENT generation, not just truthiness, so a stale poll finishing
   *  late can never block — or clear — a newer generation's own guard. */
  private pollingGeneration: number | null = null;
  /** Set by reportPollFailure()/reportPollSuccess() on every poll result —
   *  overrides the supervisor's own status in relayStatus(), because a
   *  supervisor that still reports "running" is not the same fact as a relay
   *  actually answering: a hung process is running and not answering both. */
  private relayNotAnswering = false;

  // ── The last poll's answer, and what is derived from it ─────────────────
  private lastPaths = new Map<string, RelayPath>();
  private readonly bframesMarks = new Map<string, BFramesMark>();
  /** Feed ids whose relay log reported a B-frames close while the feed's own
   *  path was not yet ready (an on-demand pull feed the relay had not
   *  finished dialling) — resolved the next time a poll sees that path
   *  ready, in settleFeeds(). See R12c. */
  private readonly pendingBFrames = new Set<string>();
  /** The readyTime a B-frames mark was last ANNOUNCED at, per feed — so the
   *  same still-open session does not repeat the log line every time the
   *  relay logs another closed WebRTC attempt against it. */
  private readonly bframesAnnouncedAt = new Map<string, string | null>();
  /** Epoch ms a WHEP/HLS request last named a feed — task 13's noteRequested(). */
  private readonly requestedAt = new Map<string, number>();
  /** The last FeedState logged for each feed, so "is live"/"is delayed"/
   *  "went offline" fire on the transition only. */
  private readonly lastLoggedState = new Map<string, FeedState | null>();
  /** One shared log, two streak keys: "relay-status" for the relay not
   *  answering a poll, "seen-store" for the seen store failing to write —
   *  different facts, each its own outage rather than one per poll. */
  private readonly pollOutage = new OutageLog();

  private pollTimer: NodeJS.Timeout | null = null;

  allowedKinds(): ReadonlySet<VideoSourceKind> {
    return new Set<VideoSourceKind>(["embed", "external"]);
  }

  private relayStatus(ports: VideoPorts): RelayStatus {
    if (!this.supervisor) return { state: "off" };
    if (this.relayNotAnswering) return { state: "failing", reason: "The relay is not answering", retryAt: null };
    const status = this.supervisor.status();
    switch (status.state) {
      case "off":
        return { state: "off" };
      case "starting":
        return { state: "starting", version: this.supervisor.version() };
      case "running":
        return { state: "running", version: this.supervisor.version() ?? "", ports };
      case "failing":
        return { state: "failing", reason: status.reason, retryAt: status.retryAt };
    }
  }

  protected feedStatus(feed: VideoFeed): FeedStatus {
    const kind = feed.source.kind;
    if (kind === "embed") return { state: "embed" };
    if (kind === "external") return { state: null };
    return this.relayFeedStatus(feed.id, kind);
  }

  private relayFeedStatus(feedId: string, kind: "pull" | "push"): FeedStatus {
    return feedState({
      kind,
      path: this.lastPaths.get(feedId),
      bframesMark: this.bframesMarks.get(feedId),
      recentlyRequested: this.isRecentlyRequested(feedId),
      lastSeenAt: lastSeenAt(feedId),
    });
  }

  private isRecentlyRequested(feedId: string): boolean {
    const at = this.requestedAt.get(feedId);
    return at !== undefined && Date.now() - at < RECENT_REQUEST_MS;
  }

  private play(feed: VideoFeed): FeedPlay {
    const s = feed.source;
    if (s.kind === "embed") return { via: "embed", src: embedSrc(s.player, s.ref) };
    if (s.kind === "external") return { via: "external", url: s.url, protocol: externalProtocol(s.url) };
    const base = `/video/${feed.id}`;
    return { via: "relay", whep: `${base}/whep`, hls: `${base}/index.m3u8` };
  }

  /** The page's list line: what kind of source, then its address, protocol
   *  or embed reference — "Pulled from a device · rtsp://…". */
  private sourceLine(feed: VideoFeed): string {
    const s = feed.source;
    const detail =
      s.kind === "pull" || s.kind === "external"
        ? s.url
        : s.kind === "push"
          ? { srt: "SRT", rtmp: "RTMP", whip: "WHIP (OBS)" }[s.protocol]
          : s.ref;
    return `${SOURCE_LINE_KIND[s.kind]} · ${detail}`;
  }

  view(feed: VideoFeed): VideoFeedView {
    return {
      id: feed.id, name: feed.name, kind: feed.source.kind, source: feed.source,
      sourceLine: this.sourceLine(feed), play: this.play(feed), status: this.feedStatus(feed),
    };
  }

  async state(): Promise<VideoState> {
    const { feeds, ports } = await loadFeedsFile();
    return {
      rev: this.rev,
      relay: this.relayStatus(ports),
      kinds: [...this.allowedKinds()],
      feeds: feeds.map((f) => this.view(f)),
    };
  }

  /** Synchronous snapshot for writeHelloBurst — see the field comment above. */
  current(): VideoState {
    return this.snapshot;
  }

  /** Computes the first snapshot. Called once at startup, beside the other
   *  service inits (see server.ts). */
  async init(): Promise<void> {
    await loadSeen();
    this.snapshot = await this.state();
  }

  /**
   * Publishes only when the computed snapshot actually differs from the last
   * one published (everything but `rev`) — otherwise a poll every
   * STATUS_POLL_MS would be an SSE frame every STATUS_POLL_MS. `current()` is
   * kept fresh either way, so a hello burst between changes still hydrates
   * with the truth rather than a stale snapshot.
   */
  protected async publish(): Promise<void> {
    const candidate = await this.state();
    const changed = this.body(candidate) !== this.body(this.snapshot);
    if (changed) this.rev++;
    this.snapshot = { ...candidate, rev: this.rev };
    if (changed) broadcast("video:state", this.snapshot);
  }

  private body(s: VideoState): string {
    const { rev: _rev, ...body } = s;
    return JSON.stringify(body);
  }

  // ── The relay: attached once by task 15, polled while watched ───────────

  /** Give the service a relay and its supervisor. Safe to call again with no
   *  detachRelay() first — the previous relay's listeners are removed here,
   *  never left to leak (Minor #8), but nothing is published for that half:
   *  a caller replacing one relay with another wants ONE settled state at
   *  the end, not an intermediate "off" broadcast between the two. */
  attachRelay(relay: VideoRelay, supervisor: RelaySupervisorLike): void {
    if (this.relay) this.detachInternal();
    this.relayGeneration++;
    this.relay = relay;
    this.supervisor = supervisor;
    this.lineListener = (text: string) => this.handleLine(text);
    // R12b: starting and failing-with-retry must reach video:state as soon
    // as the supervisor itself knows them, not only on the next poll tick —
    // a poll may be minutes away if nothing is watching yet when the relay
    // first spawns.
    this.spawnedListener = () => void this.publish();
    this.exitListener = () => void this.publish();
    supervisor.on("line", this.lineListener);
    supervisor.on("spawned", this.spawnedListener);
    supervisor.on("exit", this.exitListener);
    this.subscriptionsChanged();
  }

  /** Stop polling, forget the relay, and publish the result — the page and
   *  every widget are told the relay is off, not left showing whatever it
   *  last reported. */
  async detachRelay(): Promise<void> {
    this.detachInternal();
    await this.publish();
  }

  /** The cleanup half of detachRelay(), split out so attachRelay() can reuse
   *  it when replacing a relay without an intermediate publish — see
   *  attachRelay()'s own comment. */
  private detachInternal(): void {
    if (this.supervisor) {
      if (this.lineListener) this.supervisor.off("line", this.lineListener);
      if (this.spawnedListener) this.supervisor.off("spawned", this.spawnedListener);
      if (this.exitListener) this.supervisor.off("exit", this.exitListener);
    }
    this.relayGeneration++;
    this.relay = null;
    this.supervisor = null;
    this.lineListener = null;
    this.spawnedListener = null;
    this.exitListener = null;
    this.relayNotAnswering = false;
    this.stopPolling();
    // "No path" is exactly how feedState() reads a relay it cannot ask.
    this.lastPaths = new Map();
  }

  /**
   * Start or stop the status poll, from demand as it stands right now.
   * Registered once below on every broadcaster subscription change — see
   * cue-live.ts's identical use of addSubscriptionListener for the same
   * "no timer with nobody watching" rule.
   */
  subscriptionsChanged(): void {
    if (this.relay && videoPollDeps.inDemand()) this.startPolling();
    else this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = videoPollDeps.setInterval(() => void this.pollOnce(), STATUS_POLL_MS);
    // The first read goes out at once: a page or widget that just subscribed
    // is looking at whatever the last poll left, which could be nothing.
    void this.pollOnce();
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    videoPollDeps.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    if (!this.relay) return;
    const generation = this.relayGeneration;
    // Per-GENERATION, not a plain boolean: a boolean guard here let an old
    // relay's still-in-flight poll block a brand new relay's own first read
    // after a fast detach+reattach, because the flag stayed "true" across
    // the swap and nothing ever cleared it for the new attachment. Minor #4.
    if (this.pollingGeneration === generation) return;
    this.pollingGeneration = generation;
    const relay = this.relay;
    try {
      let paths: RelayPath[];
      try {
        paths = await relay.status();
      } catch (err) {
        if (this.relayGeneration !== generation) return; // this relay was detached mid-request
        this.reportPollFailure(err);
        // R12a: a relay that stops answering is not "the last known paths,
        // still", because nothing here can any longer tell a genuinely live
        // feed from one the relay simply stopped reporting on. Every pull/
        // push feed reads "no path" until the next successful poll.
        this.lastPaths = new Map();
        await this.settleFeeds();
        return;
      }
      if (this.relayGeneration !== generation) return; // this relay was detached mid-request
      this.reportPollSuccess();
      this.lastPaths = new Map(paths.map((p) => [p.name, p]));
      await this.settleFeeds();
    } finally {
      if (this.pollingGeneration === generation) this.pollingGeneration = null;
    }
  }

  /** Every pull/push feed's status, derived from the poll that just ran (or
   *  just failed) — logged on transition, seen-stored while ready, and
   *  published once, whether the poll succeeded or not. */
  private async settleFeeds(): Promise<void> {
    const { feeds } = await loadFeedsFile();
    const now = Date.now();
    for (const feed of feeds) {
      const kind = feed.source.kind;
      if (kind !== "pull" && kind !== "push") continue;
      const path = this.lastPaths.get(feed.id);

      if (path?.ready && this.pendingBFrames.has(feed.id)) {
        this.pendingBFrames.delete(feed.id);
        await this.bindBFramesMark(feed, path.readyTime);
      }

      const status = this.relayFeedStatus(feed.id, kind);
      if (path?.ready) await this.recordSeen(feed.id, now);

      const leftReady = this.logTransition(feed, status);
      // Item 9: noteSeen()'s own write is throttled to once a minute, so the
      // TRUE last-seen moment can sit in memory only, up to a minute stale on
      // disk, right when a feed drops — flush it the moment that happens.
      if (leftReady) await this.flushSeenSafely(feed.id);
    }
    await this.publish();
  }

  private reportPollFailure(err: unknown): void {
    this.relayNotAnswering = true;
    const message = errorMessage(err);
    const decision = this.pollOutage.fail("relay-status", message, Date.now());
    if (decision.log) console.warn(`[video] the relay is not answering: ${scrub(message)}${scrub(decision.note)}`);
  }

  private reportPollSuccess(): void {
    this.relayNotAnswering = false;
    const decision = this.pollOutage.ok("relay-status", Date.now());
    if (decision.log) console.log(`[video] the relay is answering again${scrub(decision.note)}`);
  }

  /** Important #3: a rejected seen-store write must never abort the poll it
   *  happened inside of (the transition still has to log and publish), and
   *  must never surface as an unhandled rejection — it is reported the same
   *  way a relay that stops answering is, one line per outage. */
  private async recordSeen(feedId: string, at: number): Promise<void> {
    try {
      await noteSeen(feedId, at);
      this.reportSeenStoreSuccess();
    } catch (err) {
      this.reportSeenStoreFailure(err);
    }
  }

  private async flushSeenSafely(feedId: string): Promise<void> {
    try {
      await flushSeen(feedId);
      this.reportSeenStoreSuccess();
    } catch (err) {
      this.reportSeenStoreFailure(err);
    }
  }

  private reportSeenStoreFailure(err: unknown): void {
    const message = errorMessage(err);
    const decision = this.pollOutage.fail("seen-store", message, Date.now());
    if (decision.log) console.warn(`[video] could not save the last-seen time: ${scrub(message)}${scrub(decision.note)}`);
  }

  private reportSeenStoreSuccess(): void {
    const decision = this.pollOutage.ok("seen-store", Date.now());
    if (decision.log) console.log(`[video] saving the last-seen time is working again${scrub(decision.note)}`);
  }

  /** "1920×1080 H264", "H264" alone, or "" when nothing about the picture is
   *  known — never "undefined×undefined undefined": a ready path with no
   *  video track yet is a real, reachable state, not a bug to paper over. */
  private pictureText(status: FeedStatus): string {
    const dims = status.width && status.height ? `${status.width}×${status.height}` : null;
    return [dims, status.codec].filter((part): part is string => Boolean(part)).join(" ");
  }

  /**
   * "is live"/"is delayed"/"went offline" on the transition only — never on
   * every poll, and "went offline" never on a feed's first-ever sighting (a
   * fresh server has nothing to call a transition FROM).
   *
   * @returns whether this update left a ready (live/delayed) state — the
   *   caller flushes the seen store's throttled write on exactly that
   *   transition (Item 9), so this decides it once rather than the caller
   *   re-deriving the same prev/next comparison a second time.
   */
  private logTransition(feed: VideoFeed, status: FeedStatus): boolean {
    const prev = this.lastLoggedState.get(feed.id);
    this.lastLoggedState.set(feed.id, status.state);
    const wasReady = prev === "live" || prev === "delayed";
    const isReady = status.state === "live" || status.state === "delayed";

    if (prev !== status.state) {
      const picture = this.pictureText(status);
      const parens = picture ? ` (${picture})` : "";
      if (status.state === "live") {
        console.log(`[video] ${scrub(feed.name)} is live${scrub(parens)}`);
      } else if (status.state === "delayed" && status.delayedBecause === "codec") {
        // Not the "b-frames" reason: bindBFramesMark() already announces
        // that one, with more useful advice than a plain state-change line
        // could carry — logging both here would say the same thing twice.
        console.log(`[video] ${scrub(feed.name)} is delayed${scrub(parens)} — an unsupported codec`);
      } else if (status.state === "offline" && prev !== undefined && prev !== "offline") {
        console.log(`[video] ${scrub(feed.name)} went offline`);
      }
    }
    return wasReady && !isReady;
  }

  private handleLine(text: string): void {
    const event = this.logWatcher.line(text);
    if (event?.kind === "b-frames") void this.markBFrames(event.path);
  }

  /**
   * The relay's log just reported a WebRTC session on `feedId` closing for
   * B-frames. `feedId` is parsed straight out of the relay's own log text —
   * Minor #5 — so it is checked against the CURRENT feed list before it
   * becomes a Map key or reaches a log line: an orphaned relay path (a feed
   * deleted before the relay reconciled) must never be logged raw.
   *
   * If the feed's own path is not yet ready, this is an on-demand pull feed
   * the relay dialled, read for a moment, and closed for B-frames — all
   * before this service's own poll caught up with a readyTime to bind the
   * mark to. Remembered as PENDING (R12c) and resolved the next time a poll
   * sees that path ready, in settleFeeds().
   */
  private async markBFrames(feedId: string): Promise<void> {
    const { feeds } = await loadFeedsFile();
    const feed = feeds.find((f) => f.id === feedId);
    if (!feed) return;
    const path = this.lastPaths.get(feedId);
    if (path?.ready) {
      await this.bindBFramesMark(feed, path.readyTime);
    } else {
      this.pendingBFrames.add(feedId);
    }
  }

  private async bindBFramesMark(feed: VideoFeed, readyTime: string | null): Promise<void> {
    this.bframesMarks.set(feed.id, { readyTime });
    if (this.bframesAnnouncedAt.get(feed.id) === readyTime) return; // already said, for this same session
    this.bframesAnnouncedAt.set(feed.id, readyTime);
    console.log(
      `[video] ${scrub(feed.name)} sends B-frames, so screens play it over HLS, 2 to 6 s behind. ` +
        `Turn B-frames off on the device for under a second.`,
    );
  }

  /**
   * Task 13's playback proxy calls this on every WHEP POST and playlist GET,
   * so an on-demand pull feed nothing has watched for RECENT_REQUEST_MS reads
   * as "standby" rather than "offline" — see feed-state.ts.
   *
   * `feedId` is whatever the proxy read off the URL, so it is validated
   * against the CURRENT feed list before it ever becomes a Map key: an
   * unbounded set of attacker strings each minting an entry is the
   * request-keyed-map problem this avoids by construction, not only by using
   * a Map instead of a plain object.
   */
  async noteRequested(feedId: string): Promise<void> {
    if (!FEED_ID_PATTERN.test(feedId)) return;
    const { feeds } = await loadFeedsFile();
    if (!feeds.some((f) => f.id === feedId)) return;
    this.requestedAt.set(feedId, Date.now());
  }

  // ── Feeds ─────────────────────────────────────────────────────────────

  async addFeed(body: unknown): Promise<Result> {
    const parsed = parseFeedInput(body, this.allowedKinds());
    if (!parsed.ok) return { ok: false, error: parsed.error };

    // The id is chosen INSIDE the store's queued update, against the list as
    // it stands at that moment. Chosen from a read taken before it, two adds
    // of one name in flight together both saw the same list and both took the
    // same id.
    let feed: VideoFeed | undefined;
    await videoFeedsStore.update((current) => {
      const feeds = feedsOf(current);
      feed = { id: feedIdFor(parsed.name, new Set(feeds.map((f) => f.id))), name: parsed.name, source: parsed.source };
      return { ...current, feeds: [...feeds, feed] };
    });
    if (!feed) throw new Error("[video] the feed store's update never ran");
    const added = feed;

    // The password goes in under the id the update chose. The feed is not
    // published until it has: a feed visible with no password behind it is
    // worse than one that never appears, so a failed write takes the feed
    // back out and the failure goes to the caller.
    if (parsed.password) {
      try {
        await secretsStore.setSecret(SECRET_SLOT(added.id), "password", parsed.password);
      } catch (err) {
        await videoFeedsStore.update((current) => ({ ...current, feeds: feedsOf(current).filter((f) => f.id !== added.id) }));
        throw err;
      }
    }
    await this.publish();
    return { ok: true, feed: this.view(added) };
  }

  async updateFeed(id: string, body: unknown): Promise<Result> {
    // Checked with the pattern, then looked up with Array.find on the loaded
    // list — never used as an object key. See feed-id.ts.
    if (!FEED_ID_PATTERN.test(id)) return { ok: false, error: "not-found" };
    const { feeds } = await loadFeedsFile();
    const existing = feeds.find((f) => f.id === id);
    if (!existing) return { ok: false, error: "not-found" };

    // Re-running parseFeedInput is what makes a name-only PATCH ({ name }) valid
    // without a second copy of the name rules: it is this same call with the
    // existing source (and, now, the body's own password) handed back through.
    const parsed = parseFeedInput(mergedFeedPatch(existing, body), this.allowedKinds());
    if (!parsed.ok) return { ok: false, error: parsed.error };

    // The id never changes on update — it is the layout binding's permanent
    // key (see main/types/video.ts). Only feedIdFor(), at creation, mints one.
    const feed: VideoFeed = { id, name: parsed.name, source: parsed.source };

    if (parsed.password) await secretsStore.setSecret(SECRET_SLOT(id), "password", parsed.password);

    await videoFeedsStore.update((current) => ({
      ...current,
      feeds: feedsOf(current).map((f) => (f.id === id ? feed : f)),
    }));
    await this.publish();
    return { ok: true, feed: this.view(feed) };
  }

  async removeFeed(id: string): Promise<boolean> {
    // Same check as updateFeed, and the same reason: an id this shape never
    // mints, so it can only ever equal a feed that got into the store some
    // other way (a hand-edited or restored file). Refusing it here keeps the
    // two mutating routes agreeing on what a feed id is, instead of DELETE
    // quietly accepting what PATCH would refuse.
    if (!FEED_ID_PATTERN.test(id)) return false;
    const { feeds } = await loadFeedsFile();
    if (!feeds.some((f) => f.id === id)) return false;

    await videoFeedsStore.update((current) => ({ ...current, feeds: feedsOf(current).filter((f) => f.id !== id) }));
    await secretsStore.clearSecrets(SECRET_SLOT(id));
    // A future feed CAN mint this same id again (feedIdFor() is deterministic
    // from the name), but that is a new feed with a new relay path — nothing
    // about this one's old poll data, request or log history describes it.
    // Dropped rather than left to grow across every feed a server ever had.
    this.lastPaths.delete(id);
    this.bframesMarks.delete(id);
    this.bframesAnnouncedAt.delete(id);
    this.pendingBFrames.delete(id);
    this.requestedAt.delete(id);
    this.lastLoggedState.delete(id);
    // Minor #6: without this, a re-added feed under the same name (a new
    // feed, minting the same deterministic id) reads "offline, last seen
    // <old>" instead of "waiting" — the old feed's history, not its own.
    await forgetSeen(id);
    await this.publish();
    return true;
  }

  async usage(id: string): Promise<{ viewId: string; name: string }[]> {
    const out: { viewId: string; name: string }[] = [];
    for (const v of await viewsStore.load()) {
      if (!v.layout) continue;
      let uses = false;
      walkLayoutObjects(v.layout.objects, (o) => {
        // Read structurally: a view written by a newer build may carry object
        // types, or config fields, this one does not know.
        const c = o.config as { type: string; feedId?: unknown };
        if (c.type === "video" && c.feedId === id) uses = true;
      });
      if (uses) out.push({ viewId: v.id, name: v.name });
    }
    return out;
  }
}

export const videoService = new VideoService();

addSubscriptionListener(() => videoService.subscriptionsChanged());
