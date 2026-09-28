// main/services/video/video-service.ts — feeds, their status and the relay.
//
// The one owner of `video:state`. Every change goes through here and ends in
// publish(), so the page, every widget and the hello burst see one snapshot.

import { EventEmitter } from "node:events";

import { addSubscriptionListener, broadcast, channelInDemand } from "../broadcaster.js";
import { DEFAULT_VIDEO_PORTS } from "../../types/video.js";
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
/** How long a PENDING B-frames mark (one whose feed was not yet ready when
 *  the close was logged) waits for a ready poll before it is forgotten.
 *  Without an expiry, a mark that never resolves would bind to whatever
 *  unrelated session eventually makes the feed ready again — hours or days
 *  later, and possibly after the encoder's B-frames setting was fixed. */
export const PENDING_MARK_TTL_MS = 30_000;
/** How long after the supervisor reports "running" a failed poll is still
 *  read as the relay simply not open for business yet, not as it failing to
 *  answer. The supervisor marks a process "running" the moment it spawns,
 *  well before MediaMTX has actually opened its API — so a poll landing in
 *  that window failing is normal, not news, and logs nothing. */
export const RELAY_BOOT_GRACE_MS = 10_000;

/**
 * The slice of RelaySupervisor the service needs: an EventEmitter for its
 * "line" and "status" events, plus its own status()/version(). A real
 * RelaySupervisor (supervisor.ts) satisfies this structurally with no cast;
 * a test hands in a bare EventEmitter with the two methods added.
 */
export interface RelaySupervisorLike extends EventEmitter {
  status(): SupervisorStatus;
  version(): string | null;
  on(event: "line", listener: (text: string) => void): this;
  on(event: "status", listener: (status: SupervisorStatus) => void): this;
  off(event: "line", listener: (text: string) => void): this;
  off(event: "status", listener: (status: SupervisorStatus) => void): this;
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

  // ── The relay, attached when video is switched on ───────────────────────
  private relay: VideoRelay | null = null;
  private supervisor: RelaySupervisorLike | null = null;
  /**
   * The ports the CURRENT relay process was actually started with — pinned
   * at attachRelay(), never re-read from the store while the same process
   * keeps running. relayStatus()'s "running" ports come from here, not from
   * loadFeedsFile(): a `PATCH /api/video/ports` change (PR 2) writes the
   * store immediately but the relay itself keeps listening on its OLD ports
   * until it restarts, so a poll landing between that write and the restart
   * must still answer the ports the relay is actually reachable on — R13a's
   * finding was relayTarget() pointing the proxy at a store's brand-new
   * port nothing was listening on yet.
   */
  private attachedPorts: VideoPorts | null = null;
  private lineListener: ((text: string) => void) | null = null;
  /** The ONE event the service reacts to for the supervisor's own lifecycle
   *  — a single listener rather than separate "spawned"/"exit" ones, so a
   *  "not answering" verdict earned against a dead process cannot survive
   *  into its replacement. Fired after every transition (off, starting,
   *  running, failing), from spawnChild()/onExit()/start()/stop() alike. */
  private statusListener: ((status: SupervisorStatus) => void) | null = null;
  /** Parses the supervisor's raw stdout/stderr lines into B-frames marks.
   *  Owned here rather than read off the supervisor: supervisor.ts keeps its
   *  own copy for its own exit-reason bookkeeping, and "line" is the only
   *  parsed event it re-exports. */
  private readonly logWatcher = new RelayLogWatcher();
  /**
   * Bumped on every attachRelay()/detachRelay() and on every supervisor
   * status change (handleStatusChange()): each means an answer to a poll
   * already in flight is about a relay, or a process, this service no longer
   * has. A poll captures the generation it started under and checks it again
   * once relay.status() settles, which also covers a crash-and-respawn that
   * leaves `this.relay` the same object. The reentry guard is keyed to it as
   * well (pollingGeneration below), so a stale poll still in flight never
   * blocks the first read of whatever replaced it; a plain boolean would stay
   * true across the swap and do exactly that.
   */
  private relayGeneration = 0;
  /** True while a poll for `relayGeneration` is in flight. Compared against
   *  the CURRENT generation, not just truthiness, so a stale poll finishing
   *  late can never block — or clear — a newer generation's own guard. */
  private pollingGeneration: number | null = null;
  /** Set by reportPollFailure(), which pollOnce() calls only for a failure
   *  pollFailureIsNews() lets through; cleared by reportPollSuccess() and by
   *  every supervisor status change. Overrides the supervisor's own status in
   *  relayStatus(), because a supervisor that still reports "running" is not
   *  the same fact as a relay actually answering: a hung process is running
   *  and not answering both. */
  private relayNotAnswering = false;

  // ── The last poll's answer, and what is derived from it ─────────────────
  private lastPaths = new Map<string, RelayPath>();
  private readonly bframesMarks = new Map<string, BFramesMark>();
  /** Feed ids whose relay log reported a B-frames close while the feed's own
   *  path was not yet ready (an on-demand pull feed the relay had not
   *  finished dialling) — resolved the next time a poll sees that path
   *  ready, in settleFeeds(). */
  private readonly pendingBFrames = new Set<string>();
  /** When each pending mark first went pending — see PENDING_MARK_TTL_MS. */
  private readonly pendingBFramesAt = new Map<string, number>();
  /** The readyTime a B-frames mark was last ANNOUNCED at, per feed — so the
   *  same still-open session does not repeat the log line every time the
   *  relay logs another closed WebRTC attempt against it. */
  private readonly bframesAnnouncedAt = new Map<string, string | null>();
  /** Epoch ms a WHEP/HLS request last named a feed — see markRequested(). */
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

  /**
   * The "not answering" override applies only while the supervisor itself
   * reports `running` — never `off` (a poll can fail simply because nothing
   * has started yet, which is not news), never already `failing` (the
   * supervisor's own reason and retryAt are a better answer than a generic
   * "not answering"), and never `starting` either: the real supervisor has
   * no live child at all while starting (one is not spawned until AFTER
   * "starting" ends), and `version()` survives every restart, so there is
   * no such thing as "the current attempt's own banner" to check for during
   * this state — a poll landing inside "starting" can only be asking a
   * process that either does not exist yet or belongs to a previous run.
   * Within `running`, the flag is only ever set once RELAY_BOOT_GRACE_MS have
   * passed since `since`: pollOnce() reports a failure only when
   * pollFailureIsNews() says so.
   */
  private relayStatus(): RelayStatus {
    if (!this.supervisor) return { state: "off" };
    const status = this.supervisor.status();
    switch (status.state) {
      case "off":
        return { state: "off" };
      case "failing":
        return { state: "failing", reason: status.reason, retryAt: status.retryAt };
      case "starting":
        return { state: "starting", version: this.supervisor.version() };
      case "running":
        if (this.relayNotAnswering) {
          return { state: "failing", reason: "The relay is not answering", retryAt: null };
        }
        // attachRelay() always sets attachedPorts in the same call that sets
        // supervisor, so a "running" supervisor implies this is non-null —
        // the || fallback exists only so a test double that skips attachRelay
        // cannot crash this on a type the compiler already guarantees.
        return { state: "running", version: this.supervisor.version() ?? "", ports: this.attachedPorts ?? DEFAULT_VIDEO_PORTS };
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
    // Only `feeds` comes from the store now — the running relay's OWN
    // ports come from attachedPorts (relayStatus()'s own comment), not from
    // whatever the store currently holds.
    const { feeds } = await loadFeedsFile();
    return {
      rev: this.rev,
      relay: this.relayStatus(),
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

  // ── The relay: attached when video is switched on, polled while watched ─

  /** Give the service a relay and its supervisor, and the ports THIS
   *  process was actually started with (defaulted for a caller — a test,
   *  today; nothing in production calls this yet — that does not care).
   *  Safe to call again with no detachRelay() first — the previous relay's
   *  listeners are removed here, never left to leak, but nothing is
   *  published for that half: a caller replacing one relay with another
   *  wants ONE settled state at the end, not an intermediate "off"
   *  broadcast between the two. */
  attachRelay(relay: VideoRelay, supervisor: RelaySupervisorLike, ports: VideoPorts = DEFAULT_VIDEO_PORTS): void {
    if (this.relay) this.detachInternal();
    this.relayGeneration++;
    this.relay = relay;
    this.supervisor = supervisor;
    this.attachedPorts = ports;
    this.lineListener = (text: string) => this.handleLine(text);
    // Starting and failing-with-retry must reach video:state as soon as the
    // supervisor itself knows them, not only on the next poll tick — a poll
    // may be minutes away if nothing is watching yet when the relay first
    // spawns. ONE event for every transition, not separate "spawned"/"exit"
    // listeners: a "not answering" verdict belongs to one process, and
    // handleStatusChange() is what clears it the moment the supervisor
    // itself reports the process has moved on.
    this.statusListener = (status: SupervisorStatus) => this.handleStatusChange(status);
    supervisor.on("line", this.lineListener);
    supervisor.on("status", this.statusListener);
    this.subscriptionsChanged();
  }

  /** Stop polling, forget the relay, and settle every feed's status — the
   *  page and every widget are told the relay is off and, for any feed that
   *  was live, that it went offline (logged, seen-store flushed), not left
   *  showing whatever was last reported. */
  async detachRelay(): Promise<void> {
    this.detachInternal();
    await this.settleFeeds();
  }

  /** The cleanup half of detachRelay(), split out so attachRelay() can reuse
   *  it when replacing a relay without an intermediate publish — see
   *  attachRelay()'s own comment. */
  private detachInternal(): void {
    if (this.supervisor && this.lineListener) this.supervisor.off("line", this.lineListener);
    if (this.supervisor && this.statusListener) this.supervisor.off("status", this.statusListener);
    this.relayGeneration++;
    this.relay = null;
    this.supervisor = null;
    this.attachedPorts = null;
    this.lineListener = null;
    this.statusListener = null;
    this.relayNotAnswering = false;
    this.stopPolling();
    // "No path" is exactly how feedState() reads a relay it cannot ask.
    this.lastPaths = new Map();
    // A mark — pending or bound — describes a relationship to THIS relay's
    // paths. A pending one surviving a detach is exactly how it binds to a
    // later, unrelated session once some other relay (or this one
    // reconfigured) makes the same feed id ready again.
    this.pendingBFrames.clear();
    this.pendingBFramesAt.clear();
    this.bframesMarks.clear();
    this.bframesAnnouncedAt.clear();
  }

  /**
   * A "not answering" verdict belongs to one process. Whenever the
   * supervisor's OWN status changes — spawn, exit, stop, from its own crash
   * detection or an operator's start()/stop() — any verdict from polls
   * against whatever process was current a moment ago is stale, and cleared
   * unconditionally. `lastPaths` is cleared too when the new state is not
   * "running": nothing here can any longer tell a genuinely live feed from
   * one the relay simply stopped reporting on. Settles every feed (not a
   * bare publish) so a feed that was live logs "went offline" and flushes
   * its seen-store entry right away — the service never polls while the
   * supervisor is off, so no later poll would ever do it otherwise.
   *
   * The generation bump is what a poll already in flight against the
   * PREVIOUS process is checked against once it finally resolves or
   * rejects: without it, a poll that started before this status change can
   * land afterward and either resurrect a feed the new status already
   * marked offline, or mark the NEW process "not answering" over an answer
   * that was never really about it. Bumping it here, not only on
   * attach/detach, is what closes that gap for a status change on the SAME
   * relay object (a crash-and-respawn never detaches anything).
   */
  private handleStatusChange(status: SupervisorStatus): void {
    this.relayGeneration++;
    this.relayNotAnswering = false;
    if (status.state !== "running") this.lastPaths = new Map();
    void this.settleFeeds();
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
    // A relay the supervisor itself reports off is not "not answering" — it
    // was told to stop, and polling it is not a question worth asking.
    // Checked fresh on every tick rather than only when the poll loop
    // starts/stops, since the supervisor can go off between ticks with
    // nothing here re-running subscriptionsChanged() to notice.
    if (!this.relay || !this.supervisor || this.supervisor.status().state === "off") return;
    const generation = this.relayGeneration;
    // Per-GENERATION, not a plain boolean: a boolean guard here let an old
    // relay's still-in-flight poll block a brand new relay's own first read
    // after a fast detach+reattach, because the flag stayed "true" across
    // the swap and nothing ever cleared it for the new attachment.
    if (this.pollingGeneration === generation) return;
    this.pollingGeneration = generation;
    const relay = this.relay;
    try {
      let paths: RelayPath[];
      try {
        paths = await relay.status();
      } catch (err) {
        // The generation check catches BOTH a detach/reattach and a status
        // change on the same relay object (a crash mid-request, say) — see
        // handleStatusChange()'s own comment for why it bumps the same
        // counter. Either way this answer is about a process this service
        // no longer has, and must change nothing.
        if (this.relayGeneration !== generation) return;
        if (this.pollFailureIsNews()) this.reportPollFailure(err);
        // A relay that stops answering is not "the last known paths,
        // still", because nothing here can any longer tell a genuinely live
        // feed from one the relay simply stopped reporting on. Every pull/
        // push feed reads "no path" until the next successful poll.
        this.lastPaths = new Map();
        await this.settleFeeds();
        return;
      }
      if (this.relayGeneration !== generation) return; // see the comment in the catch branch above
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

      if (this.pendingBFrames.has(feed.id)) {
        const pendingSince = this.pendingBFramesAt.get(feed.id) ?? 0;
        if (now - pendingSince >= PENDING_MARK_TTL_MS) {
          // 30 s with no ready poll — forgotten, not left to bind whenever
          // this feed next happens to become ready, possibly long after the
          // actual B-frames report stopped meaning anything.
          this.pendingBFrames.delete(feed.id);
          this.pendingBFramesAt.delete(feed.id);
        } else if (path?.ready) {
          this.pendingBFrames.delete(feed.id);
          this.pendingBFramesAt.delete(feed.id);
          await this.bindBFramesMark(feed, path.readyTime);
        }
      }

      const status = this.relayFeedStatus(feed.id, kind);
      if (path?.ready) await this.recordSeen(feed.id, now);

      const leftReady = this.logTransition(feed, status);
      // noteSeen()'s own write is throttled to once a minute, so the TRUE
      // last-seen moment can sit in memory only, up to a minute stale on
      // disk, right when a feed drops — flush it the moment that happens.
      if (leftReady) await this.flushSeenSafely(feed.id);
    }
    await this.publish();
  }

  /**
   * Whether a failed poll says something the supervisor has not: only while
   * it reports the process "running" and RELAY_BOOT_GRACE_MS have passed
   * since `since`. While "starting" there is no child to answer yet; in a
   * crash backoff ("failing") the supervisor has already logged the exit and
   * carries its own reason; and inside the grace window MediaMTX may not have
   * opened its API yet, because the supervisor marks a process "running" the
   * moment it spawns. pollOnce() never polls an "off" supervisor at all.
   */
  private pollFailureIsNews(): boolean {
    const status = this.supervisor?.status();
    return status?.state === "running" && Date.now() - status.since >= RELAY_BOOT_GRACE_MS;
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

  /** A rejected seen-store write must never abort the poll it
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

  /** The same wrapper as recordSeen()/flushSeenSafely() — without it, a
   *  rejected forgetSeen() (called from removeFeed(), after the feed is
   *  already gone from the store) would throw past the publish() that
   *  should still tell every client the feed is gone, and the write failure
   *  would never reach the operator at all. */
  private async forgetSeenSafely(feedId: string): Promise<void> {
    try {
      await forgetSeen(feedId);
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
   *   transition, so this decides it once rather than the caller
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
   * B-frames. `feedId` is parsed straight out of the relay's own log text,
   * so it is checked against the CURRENT feed list before it becomes a Map
   * key or reaches a log line: an orphaned relay path (a feed deleted
   * before the relay reconciled) must never be logged raw.
   *
   * If the feed's own path is not yet ready, this is an on-demand pull feed
   * the relay dialled, read for a moment, and closed for B-frames — all
   * before this service's own poll caught up with a readyTime to bind the
   * mark to. Remembered as PENDING — with a fresh timestamp only the FIRST
   * time (the clock is "since first pending", not restarted by every
   * repeat close) — and resolved, or expired, the next time a poll runs, in
   * settleFeeds().
   */
  private async markBFrames(feedId: string): Promise<void> {
    const { feeds } = await loadFeedsFile();
    const feed = feeds.find((f) => f.id === feedId);
    if (!feed) return;
    const path = this.lastPaths.get(feedId);
    if (path?.ready) {
      await this.bindBFramesMark(feed, path.readyTime);
      // Binding just changed this feed's status to "delayed" — the wire
      // must not wait for the next poll tick (up to STATUS_POLL_MS away)
      // to find out.
      await this.publish();
    } else {
      if (!this.pendingBFrames.has(feedId)) this.pendingBFramesAt.set(feedId, Date.now());
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
   * The playback proxy calls this on a WHEP POST creating a session and a
   * playlist GET, so an on-demand pull feed nothing has watched for
   * RECENT_REQUEST_MS reads as "standby" rather than "offline" — see
   * feed-state.ts.
   *
   * Synchronous and unvalidated ON PURPOSE: the only caller is
   * video-proxy-routes.ts, and only after `relayTarget(feedId, kind)` has
   * already confirmed `feedId` names a real feed of a kind that route can
   * serve — re-validating here would be a second copy of exactly that
   * check, done on every request instead of once. `feedId` must never reach
   * this from anywhere that has not already done that: it becomes a Map key
   * unchecked, which is the request-keyed-map problem this repo has been
   * bitten by, avoided here by construction rather than by validation.
   */
  markRequested(feedId: string): void {
    this.requestedAt.set(feedId, Date.now());
  }

  /**
   * Where the playback proxy (video-proxy-routes.ts) should forward a
   * `/video/<feedId>/<kind>…` request, or the reason to refuse. Read off
   * `this.snapshot` — the same synchronous truth writeHelloBurst uses (see
   * the field comment above) — so this needs no store read of its own: every
   * mutation that could change the answer (addFeed/updateFeed/removeFeed,
   * attachRelay/detachRelay, a status poll picking up "running") already ends
   * in publish(), which is what keeps the snapshot current.
   *
   * 404 for a pattern-failing or unknown id, for a kind this feed's source
   * cannot serve (embed/external have no relay path at all; "whip" beyond
   * that needs a push feed whose OWN protocol is whip — a pull feed, or a
   * push feed on SRT/RTMP, has nothing listening for a WHIP offer). 503 only
   * once a feed and kind both check out: an unknown feed is never "the relay
   * is down" even while it genuinely is.
   */
  relayTarget(
    feedId: string,
    kind: "whep" | "whip" | "hls",
  ): { host: "127.0.0.1"; port: number; path: string } | { refuse: 404 | 503 } {
    if (!FEED_ID_PATTERN.test(feedId)) return { refuse: 404 };
    const feed = this.snapshot.feeds.find((f) => f.id === feedId);
    if (!feed || (feed.source.kind !== "pull" && feed.source.kind !== "push")) return { refuse: 404 };
    if (kind === "whip" && !(feed.source.kind === "push" && feed.source.protocol === "whip")) return { refuse: 404 };
    if (this.snapshot.relay.state !== "running") return { refuse: 503 };
    const { ports } = this.snapshot.relay;
    return kind === "hls"
      ? { host: "127.0.0.1", port: ports.hls, path: `/${feedId}` }
      : { host: "127.0.0.1", port: ports.webrtcHttp, path: `/${feedId}/${kind}` };
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
    this.pendingBFramesAt.delete(id);
    this.requestedAt.delete(id);
    this.lastLoggedState.delete(id);
    // Without this, a re-added feed under the same name (a new feed,
    // minting the same deterministic id) reads "offline, last seen <old>"
    // instead of "waiting" — the old feed's history, not its own.
    await this.forgetSeenSafely(id);
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
