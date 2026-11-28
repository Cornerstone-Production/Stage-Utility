// integration-base.ts — shared lifecycle for the LAN integrations.
//
// Every integration that talks to a box on the network (OBS, REAPER, Smaart,
// ProdCom, Ross TSL, ProPresenter) had grown its own copy of the same scaffold:
// a `running` flag, an exponential reconnect with a window-aware cap, a
// de-duplicated connection-state report, and — for the ones that publish a
// snapshot — a `last` DTO plus a broadcast on change. Five copies of
// `scheduleReconnect()` had drifted into three different clamping idioms.
//
// Two layers, because the integrations genuinely come in two shapes:
//   ConnectionLifecycle   — connect/retry/report only. Enough for the ones that
//                           push data outward (TSL) or stream it (ProdCom).
//   StatusIntegration<T>  — adds the "latest snapshot" contract: hydrate a
//                           freshly-loaded display via getLatest(), broadcast on
//                           change, and fall back to an OFFLINE DTO on drop.

import {
  addChannelDemandSource,
  broadcast,
  channelHasSubscribers,
  channelInDemand,
} from "./broadcaster.js";
import { DEFAULT_SETTLE_MS, OutageLog } from "./repeat-log.js";
import { serviceWindow } from "./service-window.js";
import { backoffMs, cleared } from "./timers.js";

/** Connection state as reported to the Integrations panel. */
export type ConnState = "connected" | "error" | "disconnected";

/** Default first retry delay; doubles per attempt, then clamped by serviceWindow.
 *  A subclass can raise it via `reconnectBaseMs` (ProPresenter waits 5s). */
const RECONNECT_BASE_MS = 3000;

/** The fixed reconnect ceiling of an OUTPUT (RossTalk, TSL); see reconnectCeilingMs. */
export const OUTPUT_RECONNECT_CEILING_MS = 30_000;

/** The one key this integration's outage log keeps its run under. */
const OUTAGE_KEY = "connection";

export abstract class ConnectionLifecycle {
  protected running = false;

  /**
   * Which run of this integration is current. Bumped by every stop(); capture
   * it (`const run = this.run`) before an await and ask `current(run)` after it.
   *
   * `running` cannot answer that. restart() is stop() then start() in the same
   * tick, so `running` goes false and back to true while a read against the OLD
   * host is still in flight; the read resumes, sees `running`, and acts for the
   * new host. A failure wrote "Can't reach <old host>" on the new host's row,
   * blanked its displays and replaced its healthy poll timer with a back-off; a
   * success was published as the new box's state. PVP, ProPresenter and OBS
   * each carried a guard of their own for it, and REAPER, Resi, YouTube and
   * Smaart did not.
   */
  private runId = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /**
   * This integration's outage, so a failure is said once per OUTAGE — see
   * noteOutage. One run at a time, under one key; a kind per distinct line.
   */
  private readonly connectionOutages = new OutageLog();
  /** Re-asks whether a recovery has held, for an integration whose success is
   *  a single event (a socket that connects and stays up). See noteHealthy. */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private onConn: ((state: ConnState, message: string | null) => void) | null = null;
  private reported: ConnState | null = null;
  /** The message that went WITH `reported`. Kept beside it because a state that
   *  has not changed can still be describing something different — see report().
   *  `null` is a real value here (prodcom reports "disconnected", null), so the
   *  pair is only "nothing reported yet" when `reported` is null too. */
  private reportedMessage: string | null = null;

  /**
   * @param log     short tag for console lines, e.g. "obs"
   * @param channel SSE channel; also asked whether anyone is watching, so an
   *                unwatched integration can back off further between retries
   */
  protected constructor(
    protected readonly log: string,
    protected readonly channel: string,
  ) {}

  /** Open one connection attempt. Call scheduleReconnect() on failure. */
  protected abstract connect(): Promise<void>;

  /** True when configured enough to attempt a connection at all. */
  protected abstract get configured(): boolean;

  /** Extra teardown on stop() — poll timers, stream closers. */
  protected teardown(): void {}

  /** First retry delay for this integration; doubles per consecutive failure. */
  protected get reconnectBaseMs(): number {
    return RECONNECT_BASE_MS;
  }

  /**
   * A fixed ceiling on the back-off, or null for the shared window-aware cap.
   *
   * For an OUTPUT (RossTalk, TSL). Nothing subscribes to one, so the shared cap
   * reads it as dormant all week and stretches a retry toward 30 minutes: a
   * switcher powered on mid-week would sit unreachable that long. Both used to
   * get their ceiling by overriding scheduleReconnect with a private counter,
   * which left `reconnectAttempt` at 0 for good, so every retry looked like the
   * first failure. A number here keeps the deliberate ceiling and the one
   * counter.
   */
  protected get reconnectCeilingMs(): number | null {
    return null;
  }

  /**
   * Let the event loop exit with a retry still queued. RossTalk's sockets are
   * unref'd so an idle output never holds the process open, and its pending
   * reconnect has to be too, or a shutdown (or a test run) waits for it.
   */
  protected get unrefReconnect(): boolean {
    return false;
  }

  setConnectionListener(cb: (state: ConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  start(): void {
    if (this.running || !this.configured) return;
    this.running = true;
    this.reconnectAttempt = 0;
    // A start is a fresh look: nothing learned about the old target or the old
    // credentials is true of the new ones, and a run carried across would
    // swallow the first line of the next outage.
    this.connectionOutages.forget();
    this.connectionOutages.settleAfter(this.outageSettleMs);
    this.begin();
  }

  /**
   * Take the first attempt. Split out of start() for the one subclass whose
   * cadence is not this class's timer: SenSource drives its poll through a
   * Ticker (see ticker.ts), and a bare `void this.connect()` here would run a
   * poll the ticker knows nothing about and so never re-arms.
   */
  protected begin(): void {
    void this.connect();
  }

  stop(): void {
    this.runId++;
    this.running = false;
    this.clearReconnect();
    this.clearSettle();
    this.teardown();
  }

  protected restart(): void {
    this.stop();
    if (this.configured) this.start();
  }

  /** The current run, to capture before an await. See `runId`. */
  protected get run(): number {
    return this.runId;
  }

  /** Is the run that captured `run` still the one this integration is on? False
   *  once it has been stopped, restarted or reconfigured. Checked after every
   *  await, on the failure side as well as the success side. */
  protected current(run: number): boolean {
    return this.running && run === this.runId;
  }

  /**
   * Report a change once — a repeat of the same state AND the same message is
   * dropped, so a quiet retry loop doesn't spam the Integrations panel.
   *
   * THE MESSAGE COUNTS, not just the state. This compared the state alone and
   * ignored the message entirely, so the FIRST message of a run was the one the
   * row kept, however long the run went on and however much the message changed
   * underneath it. OBS reported "OBS connection dropped — reconnecting" and then
   * "OBS rejected the password. Not reconnecting" — the second never reached the
   * badge, which went on offering a retry that was never coming. SenSource
   * reports `… occ via safespace/space×1/minute` on every connected poll and the
   * source genuinely varies, so the grid said the count came from SafeSpace for
   * hours after SafeSpace stopped answering and the occupancy reverted to Vea.
   * That is a badge asserting something no longer true, which is the class of
   * defect the badge was rewritten to fix.
   *
   * Measured before changing it, because this app is deliberately change-driven
   * and subscriber-gated and every report that passes costs a full
   * `integrations:state-changed` broadcast. Instrumented report() and ran the
   * whole suite: of 351 calls across 11 integrations, the ones whose message
   * changed while the state did not were obs (5 of 21) and sensource (34 of
   * 137); the other nine integrations had ZERO. Every obs case was a real
   * transition. SenSource's error message was the only thing that varied per
   * POLL — it carried an auth countdown, so a failing box produced a fresh
   * string every 15s — and that message was made stable rather than this dedupe
   * being weakened. See sensource-service.authHeader/exchangeToken.
   *
   * Re-measured with the change in: 261 reports pass where 220 did, 41 more
   * over the whole suite, and every one of them is the row saying something
   * different. Nothing left changes per poll.
   */
  protected report(state: ConnState, message: string | null): void {
    if (this.reported === state && this.reportedMessage === message) return;
    this.reported = state;
    this.reportedMessage = message;
    this.onConn?.(state, message);
  }

  /** Let the next report through even if the state is unchanged (after a
   *  reconfigure, where the operator expects fresh feedback). */
  protected resetReport(): void {
    this.reported = null;
    this.reportedMessage = null;
  }

  // NOTE: there is deliberately no `attempt` getter any more.
  //
  // It was read by twelve copies of `if (this.attempt === 0) console.warn(...)`.
  // The counter resets on every success, so an upstream that flaps made every
  // failure a fresh "first failure" and wrote a line per flap, indefinitely —
  // the rule repeat-log.ts records costing 3,527 lines in five days. Say a
  // failure through noteOutage instead; without the getter the old gate does
  // not compile.

  /** The connection is answering: forgive the back-off, and let the outage log
   *  see the recovery. Call it on a success, as every integration already did. */
  protected resetBackoff(): void {
    this.reconnectAttempt = 0;
    this.noteHealthy();
  }

  /**
   * Say a failure, once per outage: the first failure of a run is news, the same
   * failure again is not, a run that goes on is reminded every 15 minutes with
   * its attempt count, and a recovery is said once it has held (repeat-log.ts).
   *
   * @param line what an operator reads, without the `[tag]` — the tag is this
   *   integration's. Appended with the reminder's tail when there is one.
   * @param kind what makes two failures DIFFERENT problems. Defaults to the line
   *   itself; pass something stable when the line carries text that varies per
   *   attempt, so the variation is not mistaken for news.
   */
  protected noteOutage(line: string, kind: string = line): void {
    this.clearSettle();
    const said = this.connectionOutages.fail(OUTAGE_KEY, kind, Date.now());
    if (said.log) console.warn(`[${this.log}] ${line}${said.note}`);
  }

  /**
   * A success, for the outage log. Ends the run once no failure has followed it
   * for the settle window, which is what keeps a flapping upstream one outage.
   *
   * The first success after a failure starts the timer, and the timer asks when
   * the window has passed; a failure in between cancels it (noteOutage), and so
   * do a retry and stop(). Some integrations call resetBackoff() on every good
   * poll (ProPresenter's fallback poll, SenSource, ProdCom's WebSocket frames),
   * so a pending timer is left running: re-armed on each, a poll faster than the
   * window kept pushing it back and the outage never ended.
   */
  private noteHealthy(): void {
    if (!this.connectionOutages.failing(OUTAGE_KEY)) return;
    if (this.settleTimer) return;
    // Never asked on the success itself: OutageLog measures from the last
    // FAILURE, so after a retry gap as long as the window the first success
    // would be "recovered" at once and the next failure a fresh outage.
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.running) this.sayRecovered();
    }, this.outageSettleMs);
    // A recovery line must not hold the process open.
    this.settleTimer.unref();
  }

  /**
   * How long a recovery must go without a failure before the outage is over.
   *
   * Longer than the slowest interval this integration polls at, or every flap
   * is a recovery and a fresh outage, two lines where the old gate wrote one.
   * The default is two minutes; an integration that can poll slower than a
   * minute (Resi and YouTube when idle, Scores between games) says so.
   */
  protected get outageSettleMs(): number {
    return DEFAULT_SETTLE_MS;
  }

  /** Ask the outage log whether the run is over, and say so if it is. */
  private sayRecovered(): void {
    const said = this.connectionOutages.ok(OUTAGE_KEY, Date.now());
    if (said.log) console.log(`[${this.log}] reachable again${said.note}`);
  }

  private clearSettle(): void {
    this.settleTimer = cleared(this.settleTimer);
  }

  // NOTE: there is deliberately no `hasSubscribers` here any more.
  //
  // It answered "is a BROWSER watching", every polling integration reached for it
  // as if it meant "is anyone using this", and that is the whole bug: REAPER's
  // cadence and ProPresenter's both ignored in-process consumers, as smaart's
  // broadcast had before them. `inDemand` below is the question a subclass
  // actually wants; a genuinely browser-only gate calls channelHasSubscribers
  // directly, where reading it says so.

  /**
   * Register a consumer that needs this channel produced even with no browser
   * attached. Thin wrapper over the channel-keyed registry in broadcaster.ts —
   * see `addChannelDemandSource` there for why this distinction exists at all.
   */
  addDemandSource(wantsBroadcast: () => boolean): void {
    addChannelDemandSource(this.channel, wantsBroadcast);
  }

  /** Is anything — a browser or an in-process consumer — actually using this? */
  protected get inDemand(): boolean {
    return channelInDemand(this.channel);
  }

  /**
   * Queue the next attempt with exponential back-off, clamped by serviceWindow
   * (≤2 min inside a service window or while a client is watching; out to the
   * dormant ceiling otherwise). The raw delay is deliberately unbounded — the
   * clamp is what keeps it finite, and service-window.test.ts pins that.
   */
  protected scheduleReconnect(): void {
    if (!this.running) return;
    // A retry means the connection did not hold, whether or not a failure was
    // said first (a socket the far end closes cleanly says none).
    this.clearSettle();
    this.scheduleIn(this.nextReconnectDelayMs());
  }

  /**
   * The next back-off delay, and the attempt counter's own step.
   *
   * Split out of scheduleReconnect for a subclass that owns its own timer and so
   * needs the NUMBER rather than the arming — SenSource's poll ticker asks for
   * it on a failed tick. Calling it is what advances the back-off, exactly as
   * calling scheduleReconnect was, so it is called once per failure and not
   * peeked at.
   */
  protected nextReconnectDelayMs(): number {
    const ceiling = this.reconnectCeilingMs;
    const failures = this.reconnectAttempt + 1;
    const delay =
      ceiling === null
        ? serviceWindow.capDelayMs(backoffMs(failures, this.reconnectBaseMs), channelHasSubscribers(this.channel))
        : backoffMs(failures, this.reconnectBaseMs, ceiling);
    this.reconnectAttempt++;
    return delay;
  }

  /**
   * Queue the next connect() at an explicit delay. Polling integrations (REAPER)
   * drive their steady cadence through this so the poll and the back-off share
   * ONE timer — two timers would double the poll rate after a reconnect.
   */
  protected scheduleIn(delayMs: number): void {
    if (!this.running) return;
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => void this.connect(), delayMs);
    if (this.unrefReconnect) this.reconnectTimer.unref();
  }

  protected clearReconnect(): void {
    this.reconnectTimer = cleared(this.reconnectTimer);
  }
}

/** An integration that publishes a status snapshot on its channel. */
export abstract class StatusIntegration<T extends { connected: boolean; rev?: number }> extends ConnectionLifecycle {
  protected last: T;

  protected constructor(log: string, channel: string, protected readonly offline: T) {
    super(log, channel);
    this.last = offline;
  }

  /**
   * Monotonic version of what this integration has published, bumped ONLY when a
   * frame actually goes out on the channel.
   *
   * It exists to order the two ways a client learns the truth. A status hook
   * hydrates with a one-shot read and subscribes to this channel; if a push lands
   * before the read resolves, the older read overwrote the newer push — and
   * because the channel broadcasts only on change, the wrong value then stuck
   * until the next real change, which in a quiet building is hours.
   *
   * Both halves carry the same counter (`getLatest()` stamps it too, and every
   * hydrate route answers from `getLatest()`), so the client can compare them and
   * drop a read that is older than a push it already applied.
   *
   * "Only on a real change" is what makes the comparison meaningful: two frames
   * with the same rev describe the same published value, whichever arrived first.
   * A read may legitimately be FRESHER than the last push at the same rev —
   * Smaart keeps `last` current between throttled broadcasts — which is why the
   * client's rule is "apply unless strictly older" rather than "strictly newer".
   *
   * Deliberately NOT stored on `this.last`: emitIfChanged() compares every key of
   * the DTO, so a rev living inside the snapshot would differ on every comparison
   * and turn a change-driven channel into an unconditional one.
   */
  private rev = 0;

  /** Copy of a snapshot stamped with the current published version. */
  protected stamped(snapshot: T): T {
    return { ...snapshot, rev: this.rev };
  }

  /** Advance to the next version. Call immediately before broadcasting a frame,
   *  and only when the frame is a real change — see the note on `rev`. */
  protected bumpRev(): void {
    this.rev++;
  }

  /** Latest snapshot — lets a freshly-loaded display hydrate immediately
   *  instead of waiting for the next upstream event. Stamped, so the caller can
   *  tell this read apart from a push it may already have applied. */
  getLatest(): T {
    return this.stamped(this.last);
  }

  /**
   * Is `next` worth a frame?
   *
   * THE ONLY THING A SUBCLASS OVERRIDES. The tail below — emit, or else keep
   * `last` current silently — was copied verbatim into three of them, and the
   * `else this.last = next` half is easy to read as dead code and drop: it is
   * what lets a display connecting between changes hydrate with the truth
   * instead of a stale snapshot, and nothing about the line says so where it is
   * written out for the fourth time. A pure predicate has nowhere to put that
   * mistake.
   *
   * Shallow, over every key of the DTO. Resi and YouTube each carried a
   * hand-written copy comparing the same four fields by name, which is a list to
   * forget to extend the next time a field is added to the DTO. It is also the
   * wrong answer for any DTO holding an array — a fresh array is never `===` its
   * predecessor — which is why PVP and scores override it.
   *
   * Three integrations override this today: REAPER ticks every poll while
   * recording on purpose so a timecode display advances; PVP compares a
   * signature that deliberately omits every time-varying field; scores compares
   * the games rather than the fetch timestamp.
   */
  protected changed(prev: T, next: T): boolean {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof T>;
    for (const k of keys) {
      if (prev[k] !== next[k]) return true;
    }
    return false;
  }

  /**
   * Broadcast only when something actually changed; otherwise keep `last` fresh
   * silently.
   *
   * Both halves matter. Skipping the frame is the house SSE rule -- a poll every
   * few seconds must not be an SSE frame every few seconds. Keeping `last`
   * current is what lets a display that connects between changes hydrate with
   * the truth instead of a stale snapshot.
   *
   * Not overridden anywhere: subclasses override `changed`.
   */
  protected emitIfChanged(next: T): void {
    if (this.changed(this.last, next)) this.emit(next);
    else this.last = next;
  }

  /** Store and broadcast. Overridable for integrations that throttle (Smaart
   *  meters arrive many times a second). */
  protected emit(snapshot: T): void {
    this.last = snapshot;
    this.bumpRev();
    broadcast(this.channel, this.stamped(snapshot));
  }

  /** Drop to OFFLINE, but only if we were connected — avoids re-broadcasting
   *  the same offline snapshot on every failed retry. */
  protected goOffline(): void {
    if (this.last.connected) this.emit(this.offline);
  }

  override stop(): void {
    super.stop();
    this.goOffline();
  }
}
