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
import { serviceWindow } from "./service-window.js";

/** Connection state as reported to the Integrations panel. */
export type ConnState = "connected" | "error" | "disconnected";

/** Default first retry delay; doubles per attempt, then clamped by serviceWindow.
 *  A subclass can raise it via `reconnectBaseMs` (ProPresenter waits 5s). */
const RECONNECT_BASE_MS = 3000;

export abstract class ConnectionLifecycle {
  protected running = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
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

  setConnectionListener(cb: (state: ConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  start(): void {
    if (this.running || !this.configured) return;
    this.running = true;
    this.reconnectAttempt = 0;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearReconnect();
    this.teardown();
  }

  protected restart(): void {
    this.stop();
    if (this.configured) this.start();
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

  /** Attempts since the last success — 0 means "first failure", which the
   *  services use to log once and then stay quiet while backing off. */
  protected get attempt(): number {
    return this.reconnectAttempt;
  }

  protected resetBackoff(): void {
    this.reconnectAttempt = 0;
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
    const delay = serviceWindow.capDelayMs(
      this.reconnectBaseMs * 2 ** this.reconnectAttempt,
      channelHasSubscribers(this.channel),
    );
    this.reconnectAttempt++;
    this.scheduleIn(delay);
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
  }

  protected clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
