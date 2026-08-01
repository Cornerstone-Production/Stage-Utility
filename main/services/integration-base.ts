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

import { broadcast, channelHasSubscribers } from "./broadcaster.js";
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

  /** Report a state change once — repeat reports of the same state are dropped,
   *  so a quiet retry loop doesn't spam the Integrations panel. */
  protected report(state: ConnState, message: string | null): void {
    if (this.reported === state) return;
    this.reported = state;
    this.onConn?.(state, message);
  }

  /** Let the next report through even if the state is unchanged (after a
   *  reconfigure, where the operator expects fresh feedback). */
  protected resetReport(): void {
    this.reported = null;
  }

  /** Attempts since the last success — 0 means "first failure", which the
   *  services use to log once and then stay quiet while backing off. */
  protected get attempt(): number {
    return this.reconnectAttempt;
  }

  protected resetBackoff(): void {
    this.reconnectAttempt = 0;
  }

  /** Whether any client is watching this integration's channel. Polling
   *  integrations use it to slow down when nobody is looking. */
  protected get hasSubscribers(): boolean {
    return channelHasSubscribers(this.channel);
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
export abstract class StatusIntegration<T extends { connected: boolean }> extends ConnectionLifecycle {
  protected last: T;

  protected constructor(log: string, channel: string, protected readonly offline: T) {
    super(log, channel);
    this.last = offline;
  }

  /** Latest snapshot — lets a freshly-loaded display hydrate immediately
   *  instead of waiting for the next upstream event. */
  getLatest(): T {
    return this.last;
  }

  /** Store and broadcast. Overridable for integrations that throttle (Smaart
   *  meters arrive many times a second). */
  protected emit(snapshot: T): void {
    this.last = snapshot;
    broadcast(this.channel, snapshot);
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
