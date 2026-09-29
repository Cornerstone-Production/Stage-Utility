// main/services/video/video-service.ts — feeds, their status and the relay.
//
// The one owner of `video:state`. Every change goes through here and ends in
// publish(), so the page, every widget and the hello burst see one snapshot.

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

import { withoutDataDir } from "../app-paths.js";
import { addSubscriptionListener, broadcast, channelInDemand } from "../broadcaster.js";
import { errorMessage } from "../errors.js";
import { getLanIp } from "../lan-ip.js";
import { relayBinaryPresent } from "./acquire.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import { secretsStore } from "../secrets.js";
import { serverPort } from "../server-port.js";
import { walkLayoutObjects } from "../view-refs.js";
import { viewsStore } from "../views-store.js";
import { embedSrc } from "./embed.js";
import { FEED_ID_PATTERN, feedIdFor } from "./feed-id.js";
import { feedState, type BFramesMark } from "./feed-state.js";
import { externalProtocol, parseFeedInput } from "./feed-input.js";
import { loadFeedsFile, videoFeedsStore } from "./feed-store.js";
import { parsePorts } from "./ports.js";
import { PULL_START_TIMEOUT_MS, pullSource } from "./reconcile-plan.js";
import { RelayLogWatcher } from "./relay-log.js";
import type { RelayFeed, RelayPath, VideoRelay } from "./relay.js";
import { flushSeen, forgetSeen, lastSeenAt, loadSeen, noteSeen } from "./seen-store.js";
import type { SupervisorStatus } from "./supervisor.js";
import {
  DEFAULT_VIDEO_PORTS,
  type FeedPlay,
  type FeedState,
  type FeedStatus,
  type KickResult,
  type PushProtocol,
  type RelayStatus,
  type VideoFeed,
  type VideoFeedsFile,
  type VideoFeedView,
  type VideoPorts,
  type VideoSourceKind,
  type VideoState,
} from "../../types/video.js";

type Result = { ok: true; feed: VideoFeedView } | { ok: false; error: string };

/** newPushPassword()'s own rotation-summary line, per KickResult — never
 *  the password either side of it. */
const KICK_LOG_TEXT: Record<KickResult, string> = {
  dropped: "dropped the current publisher",
  none: "nothing was publishing",
  failed: "could not drop the current publisher",
};

export const SECRET_SLOT = (feedId: string) => `video:${feedId}`;

/** A push feed's publish password: 16 base62 characters from
 *  crypto.randomBytes, never anything predictable — it is what stands
 *  between "video" (the one publish username every push feed shares, see
 *  reconcile-plan.ts's publishUsers) and an open publish endpoint. */
const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PASSWORD_LENGTH = 16;
function generatePushPassword(): string {
  const bytes = randomBytes(PASSWORD_LENGTH);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  return out;
}

/** How often relay.status() is polled while something watches `video:state`. */
export const STATUS_POLL_MS = 3000;
/** How long after a WHEP/HLS request a pull feed the relay still reports
 *  not ready reads "offline" rather than "standby" — see feed-state.ts's
 *  `recentlyRequested`. Counted from PULL_START_TIMEOUT_MS: until the relay's
 *  own dial window has run out, a not-ready pull feed is still being dialled,
 *  and reading it offline then tore down the very session whose request had
 *  started the dial. */
export const RECENT_REQUEST_MS = PULL_START_TIMEOUT_MS + 15_000;
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
    ports: DEFAULT_VIDEO_PORTS,
    binaryPresent: false,
    feeds: [],
  };

  // ── The relay, attached when video is switched on ───────────────────────
  private relay: VideoRelay | null = null;
  private supervisor: RelaySupervisorLike | null = null;
  /**
   * Reported by relay-lifecycle.ts's start sequence for the phase no
   * supervisor exists yet to derive a RelayStatus from: ensureBinary's own
   * download progress, or a failure before any supervisor is spawned (a busy
   * port, a failed download, a config file that could not be written).
   * Cleared the moment a supervisor takes over — attachRelay() and
   * detachInternal() both do, so a stale one can never survive into an
   * attached relay's own reporting, which relayStatus() below always prefers
   * once `this.supervisor` is set. */
  private preAttachStatus: RelayStatus | null = null;
  /** relay-lifecycle.ts's own hooks — see setFeedsChangedListener's comment
   *  for why a feed CRUD needs one beyond reconcileRelay(), and setPorts()
   *  for the ports one. */
  private feedsChangedListener: (() => void) | null = null;
  private portsChangedListener: (() => void) | null = null;
  /** relay-lifecycle.ts's own connection-row mapping, fired with the fresh
   *  RelayStatus on every publish() that actually changes — the ONE place
   *  the integration manager's row is driven from, so a transition
   *  video-service discovers on its OWN poll (going "not answering", and
   *  recovering from it) reaches the row exactly the same way a supervisor
   *  event does, rather than only the page that happens to be open. */
  private relayStatusListener: ((relay: RelayStatus) => void) | null = null;
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
  /** Whether the connection row has already been told THIS attachment's
   *  version — see handleLine()'s own comment. Reset on every
   *  attachRelay()/detachInternal(), since a fresh attachment (a genuinely
   *  new supervisor, even one whose PREVIOUS run already knew a version) is
   *  a fresh announcement, not a foregone one. */
  private versionAnnounced = false;
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
  /** R14i: whether a poll has SUCCEEDED since the supervisor's status last
   *  became "running" — reset false on every status change (same moment as
   *  relayNotAnswering, in handleStatusChange()/detachInternal()) and set
   *  true only by pollOnce()'s own success path, once its generation still
   *  matches. Folded into relayFeedStatus()'s "up" check alongside
   *  "running": between the supervisor reaching running and the relay's own
   *  first successful poll, nothing here has actually heard from the
   *  process yet, so a missing path must still read standby, not offline —
   *  without this, a relay feed read "offline" the instant the supervisor
   *  said running, before the relay had ever reported ANYTHING about that
   *  feed's path. "failing" is unaffected: it means the relay WAS running
   *  and reporting a moment ago, whether or not the CURRENT process (there
   *  may be none any more) ever answered a poll of its own. */
  private polledSinceRunning = false;

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
    return new Set<VideoSourceKind>(["pull", "push", "embed", "external"]);
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
    const status = this.relayStatusWithPaths();
    if (status.state !== "failing") return status;
    // Every LAN client reads this (video:state, the integration row): no
    // data-folder path, whatever the failure's own text named. The server
    // log keeps the full one.
    const lan: RelayStatus = { ...status, reason: withoutDataDir(status.reason) };
    if (status.placeArchiveAt !== undefined) lan.placeArchiveAt = withoutDataDir(status.placeArchiveAt);
    return lan;
  }

  private relayStatusWithPaths(): RelayStatus {
    if (!this.supervisor) return this.preAttachStatus ?? { state: "off" };
    const status = this.supervisor.status();
    switch (status.state) {
      case "off":
        return { state: "off" };
      case "failing":
        // item 9 (findings-t15-r3.md): status.neverStarted is true ONLY
        // for a genuine spawn failure (node's own spawn() never created a
        // process at all) — that is a PRE-process kind, same as every
        // failPreSupervisor() kind, matching the standby ruling: nothing
        // could have received a source. Every other supervisor "failing"
        // status is the crash-loop it always was — a child process ran and
        // exited. See RelayFailureKind's own comment.
        return {
          state: "failing",
          reason: status.reason,
          kind: status.neverStarted ? "spawn" : "crash-loop",
          retryAt: status.retryAt,
        };
      case "starting":
        return { state: "starting", version: this.supervisor.version() };
      case "running":
        if (this.relayNotAnswering) {
          return { state: "failing", reason: "The relay is not answering", kind: "not-answering", retryAt: null };
        }
        // attachRelay() requires ports and sets attachedPorts in the same
        // call that sets supervisor, so a "running" supervisor GUARANTEES
        // this is non-null — asserted, not defaulted: a silent fallback
        // here is the exact bug class R13a fixed, and attachRelay()'s own
        // required parameter is what makes this assertion true rather than
        // hopeful.
        return { state: "running", version: this.supervisor.version() ?? "", ports: this.attachedPorts! };
    }
  }

  protected feedStatus(feed: VideoFeed): FeedStatus {
    const kind = feed.source.kind;
    if (kind === "embed") return { state: "embed" };
    if (kind === "external") return { state: null };
    return this.relayFeedStatus(feed.id, kind);
  }

  private relayFeedStatus(feedId: string, kind: "pull" | "push"): FeedStatus {
    // R14a/R14i, and item 14 (findings-t15-r2.md): "up" is running WITH at
    // least one poll answered since it last reached running (never true
    // fresh out of "starting", where the relay may not have opened its API
    // yet — see RELAY_BOOT_GRACE_MS's own reasoning), or failing IN A WAY
    // THAT MEANS A PROCESS ACTUALLY RAN — "crash-loop" (it exited) or
    // "not-answering" (one is running; its API just is not) — never the
    // five pre-supervisor kinds (a busy port, a failed download, a config
    // write that failed, a spawn that failed, an unsupported platform),
    // none of which ever got as far as a child existing for a source to
    // have reached. Off, starting, a running relay nothing has polled yet,
    // or a pre-supervisor failure all mean nothing here can yet tell a down
    // source from one nobody has asked about, which feedState() reads as
    // standby rather than offline.
    const relay = this.relayStatus();
    const relayUp =
      (relay.state === "running" && this.polledSinceRunning) ||
      (relay.state === "failing" && (relay.kind === "crash-loop" || relay.kind === "not-answering"));
    return feedState({
      kind,
      relayUp,
      path: this.lastPaths.get(feedId),
      bframesMark: this.bframesMarks.get(feedId),
      recentlyRequested: this.dialRanOut(feedId),
      lastSeenAt: lastSeenAt(feedId),
    });
  }

  /** Whether a request for this pull feed is old enough that the relay has
   *  had its whole dial window, and recent enough to still count — see
   *  RECENT_REQUEST_MS. */
  private dialRanOut(feedId: string): boolean {
    const at = this.requestedAt.get(feedId);
    if (at === undefined) return false;
    const age = Date.now() - at;
    return age >= PULL_START_TIMEOUT_MS && age < RECENT_REQUEST_MS;
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

  /** R14c/item 12: `hasPassword` only for a pull feed — whether a password
   *  is currently stored, NEVER the value. Lets the editor say "a password
   *  is saved" without a blank field silently implying there is none. A
   *  push feed's password is never on this view at all; it has its own
   *  dedicated GET (pushAddress()). */
  async view(feed: VideoFeed): Promise<VideoFeedView> {
    const out: VideoFeedView = {
      id: feed.id, name: feed.name, kind: feed.source.kind, source: feed.source,
      sourceLine: this.sourceLine(feed), play: this.play(feed), status: this.feedStatus(feed),
    };
    if (feed.source.kind === "pull") {
      const secrets = await secretsStore.getSecrets(SECRET_SLOT(feed.id));
      out.hasPassword = !!secrets.password;
    }
    return out;
  }

  async state(): Promise<VideoState> {
    // `ports` here is the STORED value — what relay-lifecycle.ts's next
    // start uses, and what the Advanced page's ports card edits. The running
    // relay's OWN ports (relayStatus()'s "running" variant) come from
    // attachedPorts instead, and can differ from this for the moment between
    // a ports save and the restart it triggers — see VideoState's own field
    // comment for why the two are not one field.
    const { feeds, ports } = await loadFeedsFile();
    return {
      rev: this.rev,
      relay: this.relayStatus(),
      kinds: [...this.allowedKinds()],
      ports,
      binaryPresent: await relayBinaryPresent(),
      feeds: await Promise.all(feeds.map((f) => this.view(f))),
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

  /** relay-lifecycle.ts's own status while no supervisor exists yet to ask —
   *  see the field's own comment. `null` clears it back to plain "off". */
  setPreAttachStatus(status: RelayStatus | null): void {
    this.preAttachStatus = status;
    void this.publish();
  }

  /**
   * relay-lifecycle.ts's hook for "a feed was added, changed or removed" —
   * separate from reconcileRelay() (called from the same three places),
   * because the two answer different questions. reconcileRelay() catches an
   * ALREADY-ATTACHED relay up on its paths; it is a no-op with none attached.
   * Starting the relay on the first pull/push feed, or stopping it once the
   * last one is gone, is relay-lifecycle's job, and the only way it can know
   * to look is being told a feed changed at all — this is that hook.
   */
  setFeedsChangedListener(cb: (() => void) | null): void {
    this.feedsChangedListener = cb;
  }

  /** relay-lifecycle.ts's hook for "the stored ports changed" — setPorts()'s
   *  own trigger to restart an already-running relay on the new ones. Fired
   *  only when they actually differ from what was already stored — an
   *  operator re-saving the SAME six values must never restart a running
   *  relay and drop every publisher over nothing. */
  setPortsChangedListener(cb: (() => void) | null): void {
    this.portsChangedListener = cb;
  }

  /** relay-lifecycle.ts's own connection-row mapping — see the field's own
   *  comment. `null` clears it (a caller replacing the singleton in tests). */
  setRelayStatusListener(cb: ((relay: RelayStatus) => void) | null): void {
    this.relayStatusListener = cb;
  }

  /** `PATCH /api/video/ports`: validated, saved, and — only when the saved
   *  values actually changed — relay-lifecycle.ts told to restart an
   *  already-running relay on the new ones. */
  async setPorts(body: unknown): Promise<{ ok: true; ports: VideoPorts } | { ok: false; error: string }> {
    const parsed = parsePorts(body);
    if (!parsed.ok) return parsed;
    const before = (await loadFeedsFile()).ports;
    const changed = JSON.stringify(before) !== JSON.stringify(parsed.ports);
    await videoFeedsStore.update((current) => ({ ...current, ports: parsed.ports }));
    await this.publish();
    if (changed) this.portsChangedListener?.();
    return { ok: true, ports: parsed.ports };
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
    if (changed) {
      broadcast("video:state", this.snapshot);
      this.relayStatusListener?.(this.snapshot.relay);
    }
  }

  private body(s: VideoState): string {
    const { rev: _rev, ...body } = s;
    return JSON.stringify(body);
  }

  // ── The relay: attached when video is switched on, polled while watched ─

  /** Give the service a relay and its supervisor, and the ports THIS
   *  process was actually started with. Required, not defaulted: a caller
   *  that does not know what it started the relay on has no business
   *  attaching one — a silent default here is exactly the wrong-port bug
   *  class R13a fixed (see attachedPorts's own comment), just moved one
   *  call site earlier. A ports change (`PATCH /api/video/ports`) takes
   *  effect only once the relay restarts on the new ones; whatever restarts
   *  it must attachRelay() again with THOSE ports, not reuse the old
   *  attachment.
   *  Safe to call again with no detachRelay() first — the previous relay's
   *  listeners are removed here, never left to leak, and NO intermediate
   *  "off" is published for that half: a caller replacing one relay with
   *  another gets ONE settled state at the end, published once below, not
   *  an "off" broadcast between the two. */
  attachRelay(relay: VideoRelay, supervisor: RelaySupervisorLike, ports: VideoPorts): void {
    if (this.relay) this.detachInternal();
    this.relayGeneration++;
    this.relay = relay;
    this.supervisor = supervisor;
    this.attachedPorts = ports;
    // Irrelevant from here on — relayStatus() only reads this while
    // `this.supervisor` is null — but cleared anyway so it cannot survive
    // stale into a later detach that leaves it behind.
    this.preAttachStatus = null;
    // A fresh attachment is a fresh announcement — even a supervisor whose
    // PREVIOUS run already knew a version (it survives a crash-respawn,
    // never reset by the supervisor itself) gets the row told about THIS
    // attachment explicitly, from the unconditional publish() at the end of
    // this method; version() already being non-null here just means
    // handleLine() has nothing further to do for it.
    this.versionAnnounced = supervisor.version() !== null;
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
    // The relay is genuinely attached now — the ONE settled state the
    // comment above promises. Without this, the connection row (driven
    // entirely off publish() — see setRelayStatusListener) kept showing
    // whatever it last reported before attach, until something ELSE
    // happened to publish: a later crash, or a subscriber's own poll tick.
    void this.publish();
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
    // A caller that just detached is telling relay-lifecycle.ts's own
    // sequence to report from scratch (setPreAttachStatus, next) — never
    // whatever a previous run last set.
    this.preAttachStatus = null;
    this.lineListener = null;
    this.statusListener = null;
    this.relayNotAnswering = false;
    this.polledSinceRunning = false;
    this.versionAnnounced = false;
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
    // R14i: a status change is always a DIFFERENT process's moment (even a
    // crash-and-respawn on the same object) — nothing has polled THIS one
    // yet, whatever the previous one answered.
    this.polledSinceRunning = false;
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
      // R14i: THIS generation has now genuinely heard from the relay once —
      // relayFeedStatus() may read a missing path as offline from here on,
      // for as long as this same generation lasts.
      this.polledSinceRunning = true;
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
    // item 1 (findings-t15-r2.md): the supervisor's own version() is
    // updated (supervisor.ts's attachReader()) BEFORE this listener ever
    // runs, so the moment the relay's startup banner is the line just read,
    // version() already reflects it. Without this, the connection row —
    // driven entirely off publish() — kept showing "connected" with no
    // version at all until SOME OTHER change happened to call publish()
    // again, which could be minutes away or never with nobody watching the
    // Video feeds page: current() (the SSE hello burst) genuinely never
    // updates it otherwise.
    if (!this.versionAnnounced && this.supervisor?.version()) {
      this.versionAnnounced = true;
      void this.publish();
    }
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

  // ── Reconciling the relay on a feed change ───────────────────────────────

  /**
   * A push feed's password, minting and storing a fresh one first if none is
   * currently stored — R14c. `secrets.password ?? ""` used to hand the relay
   * an EMPTY password for a push feed with no secret (a restored snapshot, a
   * wiped secrets file, or a kind change that landed between two writes),
   * and an empty `pass` is exactly READER_USER's OWN convention for "no
   * password required" (mediamtx-config.ts) — never something a PUBLISHER
   * should ever be given by accident. Logged once, and only once: the write
   * happens before the log line, so a write failure propagates to the
   * caller (reconcileRelay's own catch, or pushAddress's route) without
   * ever claiming success.
   *
   * Single-flight per feed id (R14 round 2 item 4) — this is called from
   * BOTH reconcileOnce() (relayFeeds(), every reconcile) and pushAddress()
   * (a single feed, on every GET), so a feed with no stored secret yet can
   * have both land at once; without mintingPassword each reads "no
   * password" and mints its OWN fresh one, and whichever setSecret() call
   * lands last silently wins over the other — the relay's own plan and the
   * route's answer to the operator then disagree about which password is
   * actually live. Concurrent callers instead share the ONE mint already in
   * flight: the check-and-set below has no `await` in it, so it is atomic
   * against JS's own single-threaded scheduling — whichever caller's
   * `getSecrets()` resolves first is the one that runs it and registers the
   * promise before any other caller's continuation can run.
   */
  private readonly mintingPassword = new Map<string, Promise<string>>();

  private async pushPassword(feed: VideoFeed): Promise<string> {
    const secrets = await secretsStore.getSecrets(SECRET_SLOT(feed.id));
    if (secrets.password) return secrets.password;
    const inFlight = this.mintingPassword.get(feed.id);
    if (inFlight) return inFlight;
    const mint = (async () => {
      const fresh = generatePushPassword();
      await secretsStore.setSecret(SECRET_SLOT(feed.id), "password", fresh);
      console.warn(`[video] ${scrub(feed.name)}: made a new publish password (none was stored)`);
      return fresh;
    })();
    this.mintingPassword.set(feed.id, mint);
    try {
      return await mint;
    } finally {
      this.mintingPassword.delete(feed.id);
    }
  }

  /** Every pull/push feed as the relay needs it, credentials folded in —
   *  never logged, never returned from here: the callers are reconcileOnce()
   *  (handed straight to relay.reconcile()), pushAddress() (which returns
   *  exactly one feed's own password to the route that asked for it), and
   *  relay-lifecycle.ts's start sequence, which needs the same list to build
   *  the initial config's publish users before any relay exists to reconcile
   *  against. PUBLIC for that last caller alone. */
  async relayFeeds(): Promise<RelayFeed[]> {
    const { feeds } = await loadFeedsFile();
    const out: RelayFeed[] = [];
    for (const feed of feeds) {
      const s = feed.source;
      if (s.kind === "pull") {
        const secrets = await secretsStore.getSecrets(SECRET_SLOT(feed.id));
        out.push({ id: feed.id, kind: "pull", source: pullSource(s.url, s.username, secrets.password) });
      } else if (s.kind === "push") {
        out.push({ id: feed.id, kind: "push", password: await this.pushPassword(feed) });
      }
    }
    return out;
  }

  /** True while a reconcileOnce() chain is running — see reconcileRelay()'s
   *  own comment for what this and reconcileDirty together implement. */
  private reconcileRunning = false;
  /** Set by a reconcileRelay() call that arrives while one is already
   *  running; read (and cleared) by the running chain's own loop. */
  private reconcileDirty = false;
  /** The current (or most recently finished) chain's promise — what a
   *  caller arriving mid-chain awaits, since its own change is folded into
   *  the dirty-triggered rerun rather than starting a second chain. */
  private reconcileChain: Promise<boolean> = Promise.resolve(true);

  /**
   * Make the relay match the feed store, best-effort: a failure is logged
   * once per outage (the same OutageLog the status poll uses, under its own
   * key) and never thrown — the feed store write the caller already made is
   * the source of truth, and the relay catches up on its next reconcile or
   * restart. Skipped entirely with no relay attached, or one whose
   * supervisor is not currently "running": there is nothing to ask. PUBLIC so
   * relay-lifecycle.ts's own readiness retry can call it directly once the
   * relay it just started has an API worth asking.
   *
   * R14e: single-flight. Two feed changes calling this while a reconcile is
   * already talking to the relay used to fire two overlapping
   * relay.reconcile() calls — each reading its own snapshot of the feed
   * store and racing the OTHER's writes to the relay, so the loser's own
   * change could be overwritten by the winner's now-stale plan. Instead: a
   * caller arriving mid-chain only sets `reconcileDirty` and awaits the
   * SAME chain: reconcileOnce()'s own loop below re-checks it the moment the
   * in-flight call settles and, if set, runs exactly one more pass — reading
   * the feed store and secrets FRESH at that point, so it carries every
   * change made while it was waiting, not just the one that triggered it.
   * That is "the plan is computed inside the chain": never captured before
   * entering it.
   *
   * `reconcileRunning` is cleared INSIDE reconcileLoop() itself, in a plain
   * try/finally around the do/while — not in a `.finally()` chained onto
   * this method's own returned promise, which is what an earlier version of
   * this fix did. That mattered: a `.finally()` reaction on a PROMISE is a
   * separate microtask, so it used to run one tick after the loop had
   * already decided to exit — a caller's own reconcileRelay() call landing
   * in exactly that gap saw `reconcileRunning` still true, correctly folded
   * in by setting `reconcileDirty`, and awaited `reconcileChain` — but the
   * loop had already committed to returning, so nothing was ever going to
   * check that flag again, and the change it carried was silently dropped.
   * A `finally` block INSIDE the same function has no such gap: it runs
   * synchronously, in the same tick the do/while's condition decides to
   * exit, with no `await` in between for anything else to run in. It also
   * clears the flag even if reconcileOnce() itself rejects instead of
   * returning false (it currently never does — its own try/catch inside
   * reports the failure and returns false — but nothing guarantees a future
   * change keeps that true), which an earlier version of this method did
   * not guard: an unhandled rejection skipped straight past the clearing
   * statement, wedging every later reconcileRelay() call behind a flag
   * that would never come back down.
   */
  reconcileRelay(): Promise<boolean> {
    if (this.reconcileRunning) {
      this.reconcileDirty = true;
      return this.reconcileChain;
    }
    this.reconcileRunning = true;
    this.reconcileChain = this.reconcileLoop();
    return this.reconcileChain;
  }

  private async reconcileLoop(): Promise<boolean> {
    let applied: boolean;
    try {
      do {
        this.reconcileDirty = false;
        applied = await this.reconcileOnce();
      } while (this.reconcileDirty);
    } finally {
      this.reconcileRunning = false;
    }
    return applied;
  }

  /** @returns whether the relay was actually reconciled — true when there
   *  was nothing to apply to (no relay attached, or its supervisor is not
   *  "running"), or the reconcile succeeded; false only when a relay IS
   *  running and the reconcile call itself failed. See reconcileRelay()'s
   *  own comment for the single-flight/dirty chain this runs inside. */
  private async reconcileOnce(): Promise<boolean> {
    if (!this.relay || this.supervisor?.status().state !== "running") return true;
    try {
      await this.relay.reconcile(await this.relayFeeds());
      const decision = this.pollOutage.ok("reconcile", Date.now());
      if (decision.log) console.log(`[video] reconciling the relay is working again${scrub(decision.note)}`);
      // item 1: the readiness poll (relay-lifecycle.ts's startReadinessPoll)
      // stops calling this the MOMENT it first succeeds — its own one
      // chance to catch the connection row up if handleLine() somehow
      // hasn't already. publish() itself is the guard against noise: it
      // only broadcasts when something actually changed, so a reconcile
      // that runs for an unrelated reason (a feed CRUD, a ports save) costs
      // nothing extra here on every OTHER success.
      void this.publish();
      return true;
    } catch (err) {
      const message = errorMessage(err);
      const decision = this.pollOutage.fail("reconcile", message, Date.now());
      if (decision.log) console.warn(`[video] could not reconcile the relay: ${scrub(message)}${scrub(decision.note)}`);
      return false;
    }
  }

  /**
   * addFeed/updateFeed/removeFeed's shared tail: reconcile whatever relay is
   * already attached (reconcileRelay(), above), then tell relay-lifecycle.ts
   * a feed changed at all — see setFeedsChangedListener's own comment for
   * why both are needed. newPushPassword() calls reconcileRelay() directly
   * instead: a password rotation never adds or removes a relay feed, so
   * there is nothing for relay-lifecycle to start or stop over it.
   */
  private async notifyFeedsChanged(): Promise<boolean> {
    const applied = await this.reconcileRelay();
    this.feedsChangedListener?.();
    return applied;
  }

  // ── A push feed's paste-ready address ────────────────────────────────────

  /** `srt://<lan>:<srt>?streamid=publish:<id>:video:<pw>`;
   *  `rtmp://<lan>:<rtmp>/<id>?user=video&pass=<pw>`;
   *  `http://<lan>:<this server's own port>/video/<id>/whip` — WHIP goes
   *  through the playback proxy on Stage Utility's own origin
   *  (video-proxy-routes.ts), never straight to the relay's loopback-only
   *  listener. `password` is `<pw>` for SRT/RTMP, and `video:<pw>` for WHIP
   *  because that whole string is what OBS's Bearer Token field takes.
   *  Ports come from the feed store, not `attachedPorts`: a paste-ready
   *  address is exactly as good with the relay off as running (Task 15
   *  starts it once a push/pull feed exists), and the store is what the
   *  relay WILL be listening on once it does.
   *
   *  `protocolOverride` (R14g): the editor's protocol segmented control
   *  previews the OTHER protocols' addresses before Save — same feed, same
   *  password, a different protocol's address shape — without writing
   *  anything. Defaults to the feed's own saved protocol. */
  async pushAddress(
    id: string,
    protocolOverride?: PushProtocol,
  ): Promise<{ protocol: PushProtocol; address: string; password: string } | null> {
    if (!FEED_ID_PATTERN.test(id)) return null;
    const { feeds, ports } = await loadFeedsFile();
    const feed = feeds.find((f) => f.id === id);
    if (!feed || feed.source.kind !== "push") return null;
    const pw = await this.pushPassword(feed);
    const lan = getLanIp();
    const protocol = protocolOverride ?? feed.source.protocol;
    if (protocol === "srt") {
      return { protocol, address: `srt://${lan}:${ports.srt}?streamid=publish:${id}:video:${pw}`, password: pw };
    }
    if (protocol === "rtmp") {
      return { protocol, address: `rtmp://${lan}:${ports.rtmp}/${id}?user=video&pass=${pw}`, password: pw };
    }
    return { protocol, address: `http://${lan}:${serverPort()}/video/${id}/whip`, password: `video:${pw}` };
  }

  /**
   * Writes a fresh password, reconciles the relay so it takes effect, then
   * kicks whoever is currently publishing — a new password does not by
   * itself drop an already-connected device (relay-facts.md), so without
   * the kick the OLD stream would keep going under the password just
   * replaced. The kick is attempted only while the supervisor is running
   * (R14d), best-effort and logged the same way reconcileRelay() is; its own
   * outage run closes with ok() on a successful call, kicking someone or
   * not.
   *
   * `applied`/`kicked` (R14d) let the editor say when a rotation has not
   * actually taken hold yet, rather than showing a new password nothing is
   * enforcing: `applied` is false only when a relay IS running and the
   * reconcile itself failed (true, vacuously, with no relay to apply to —
   * there is nothing wrong to report). `kicked` is three-way, not a
   * boolean (controller ruling on R14d's own flagged wording gap): "none"
   * covers BOTH "nobody was publishing" and "no relay is running to ask" —
   * two different facts a boolean could not tell apart, which is exactly
   * what let the editor's old two-state note say a device was sending when
   * none was. Only "failed" — a publisher WAS there and dropping it did
   * not work — is worth the operator's attention; see PushAddressFields.
   *
   * One rotation, one summary log line, without the password either side of
   * it: what happened to whoever was connected. The kick's own
   * failure/recovery lines (above) are separate facts about the RELAY, not
   * about this one rotation.
   */
  async newPushPassword(
    id: string,
  ): Promise<{ protocol: PushProtocol; address: string; password: string; applied: boolean; kicked: KickResult } | null> {
    if (!FEED_ID_PATTERN.test(id)) return null;
    const { feeds } = await loadFeedsFile();
    const feed = feeds.find((f) => f.id === id);
    if (!feed || feed.source.kind !== "push") return null;
    await secretsStore.setSecret(SECRET_SLOT(id), "password", generatePushPassword());
    const applied = await this.reconcileRelay();

    let kicked: KickResult = "none";
    if (this.relay && this.supervisor?.status().state === "running") {
      try {
        kicked = (await this.relay.kickPublisher(id)) ? "dropped" : "none";
        const decision = this.pollOutage.ok("push-kick", Date.now());
        if (decision.log) console.log(`[video] kicking a publisher is working again${scrub(decision.note)}`);
      } catch (err) {
        kicked = "failed";
        const message = errorMessage(err);
        const decision = this.pollOutage.fail("push-kick", message, Date.now());
        if (decision.log) console.warn(`[video] could not kick the previous publisher: ${scrub(message)}${scrub(decision.note)}`);
      }
    }

    console.log(`[video] ${scrub(feed.name)}: new publish password; ${scrub(KICK_LOG_TEXT[kicked])}`);

    const address = await this.pushAddress(id);
    if (!address) return null; // the feed vanished mid-rotation — nothing left to report against
    return { ...address, applied, kicked };
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

    // A push feed gets its password minted here, server-side, regardless of
    // what the body said — parseFeedInput's push branch never reads one, so
    // parsed.password is always undefined for it. Pull takes whatever
    // password the body supplied, if any. The feed is not published until
    // its password (if it needs one) is safely stored: a feed visible with
    // no password behind it is worse than one that never appears, so a
    // failed write takes the feed back out and the failure goes to the
    // caller.
    const password = added.source.kind === "push" ? generatePushPassword() : parsed.password;
    if (password) {
      try {
        await secretsStore.setSecret(SECRET_SLOT(added.id), "password", password);
      } catch (err) {
        await videoFeedsStore.update((current) => ({ ...current, feeds: feedsOf(current).filter((f) => f.id !== added.id) }));
        throw err;
      }
    }
    await this.publish();
    await this.notifyFeedsChanged();
    return { ok: true, feed: await this.view(added) };
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

    // The feed store write happens FIRST, updateFeedSecret() second — R14c.
    // The reverse order (this used to run the secret change BEFORE the
    // store write) meant a store write that failed left a feed whose file
    // still named the OLD kind sitting behind a secret already changed to
    // match the NEW one: a push -> pull PATCH whose store write failed had
    // already cleared the push password, though the feed on disk was still
    // push. A failure here (the store write itself) is thrown, unhandled —
    // exactly as it was before this reordering.
    await videoFeedsStore.update((current) => ({
      ...current,
      feeds: feedsOf(current).map((f) => (f.id === id ? feed : f)),
    }));
    await this.updateFeedSecret(id, existing.source.kind, feed.source.kind, parsed.password);
    await this.publish();
    await this.notifyFeedsChanged();
    return { ok: true, feed: await this.view(feed) };
  }

  /**
   * updateFeed's secrets-slot half, split out for its own comment: the rule
   * differs by whether the kind is CHANGING, not only by what it is now.
   *
   *  - Staying pull: `parsed.password` follows CLAUDE.md's wireless rule —
   *    undefined (the body left it out) leaves the stored password alone,
   *    "" clears it, anything else replaces it. feed-input.ts is what makes
   *    "" survive as "" rather than collapsing to undefined.
   *  - Becoming pull FROM something else (most notably push): the OLD
   *    secret must never survive under the new kind — "a pull feed's
   *    password comes only from its body" — so undefined here means clear,
   *    not leave alone, the one place this differs from the bullet above.
   *  - Becoming push (from anything else): a fresh password is minted the
   *    same way addFeed() mints one for a brand new push feed. Staying push
   *    touches nothing here; a push feed's password only ever changes
   *    through newPushPassword().
   *  - Landing on embed/external, having been pull or push before: the slot
   *    is cleared — an embed/external feed keeps no secret at all.
   */
  private async updateFeedSecret(
    id: string,
    oldKind: VideoSourceKind,
    newKind: VideoSourceKind,
    password: string | undefined,
  ): Promise<void> {
    if (newKind === "push") {
      if (oldKind !== "push") await secretsStore.setSecret(SECRET_SLOT(id), "password", generatePushPassword());
      return;
    }
    if (newKind === "pull") {
      if (oldKind !== "pull") {
        if (password) await secretsStore.setSecret(SECRET_SLOT(id), "password", password);
        else await secretsStore.clearSecrets(SECRET_SLOT(id));
        return;
      }
      if (password !== undefined) {
        if (password === "") await secretsStore.clearSecrets(SECRET_SLOT(id));
        else await secretsStore.setSecret(SECRET_SLOT(id), "password", password);
      }
      return;
    }
    if (oldKind === "pull" || oldKind === "push") await secretsStore.clearSecrets(SECRET_SLOT(id));
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
    await this.notifyFeedsChanged();
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
