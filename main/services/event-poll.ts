// event-poll.ts — the transport-agnostic half of the polling event transport.
//
// Some embedded browsers cannot hold a server-sent event stream. The Ross
// Ultritouch's DashBoard fallback browser buffers `GET /api/events` and releases
// its frames in batches up to a minute late, so a panel on it renders a
// minute-old service and mis-measures its clock skew by the same minute. Such a
// client opts into `?transport=poll` instead and asks
// `GET /api/events/poll?cid=…&since=…` every couple of seconds.
//
// Here: the recent-broadcast ring buffer those polls read from, and the registry
// of which poll clients are currently alive (so subscriber-gated producers count
// them the way they count an open stream). remote-server.ts owns the HTTP.
//
// Split out of remote-server.ts so the buffer and the expiry rules can be driven
// directly by a test rather than through a socket.

import { scrub } from "./scrub.js";

/** One recorded broadcast, kept as the JSON string the transport will send. */
export interface PollFrame {
  channel: string;
  serialized: string;
}

interface BufferedFrame extends PollFrame {
  seq: number;
  atMs: number;
}

export interface PollResponse {
  /** The newest sequence number the client has now seen. It sends this back as
   *  `since` on its next poll. */
  seq: number;
  /** True when the client asked from a point the buffer no longer covers, so
   *  what it is being handed is a fresh snapshot rather than a continuation. */
  resync: boolean;
  frames: PollFrame[];
}

/** Most recent broadcasts kept for replay. Bounds memory when a client stops
 *  polling without saying so — the 4 Hz spl:metrics channel alone would fill
 *  anything larger within seconds. */
const BUFFER_MAX_FRAMES = 500;
/** And an age bound, so a quiet channel's stale frame is never replayed as news. */
const BUFFER_MAX_AGE_MS = 60_000;
/** A poll client that has not asked for this long is gone (tab closed, panel
 *  rebooted). Generous next to the 2 s client cadence so a slow network or a
 *  backed-off client is not evicted mid-stride. */
export const POLL_CLIENT_TTL_MS = 30_000;
/** Ties the expiry log line's wording to the constant: change one and the other
 *  stops compiling. The line spells "30s" out because the log scan will not
 *  accept an unscrubbed interpolation, constant or not. */
POLL_CLIENT_TTL_MS satisfies 30_000;
/** How often the registry is swept for expiries. Only runs while at least one
 *  poll client exists — a timer looking for clients that are not there is the
 *  thing subscriptionsChanged exists to avoid. */
const SWEEP_INTERVAL_MS = 5_000;

export interface EventPollHubOptions {
  /** Injectable clock, so a test can age the buffer without sleeping. */
  now?: () => number;
  /** Told whenever the live poll-client set changes, so subscriber-gated
   *  producers start for a poll-only client and stop when it goes. */
  subscriptionsChanged?: () => void;
  /** A client went away, so anything keyed on its cid elsewhere can go too. */
  onExpire?: (cid: string) => void;
}

export class EventPollHub {
  private readonly buffer: BufferedFrame[] = [];
  private lastSeq = 0;
  private readonly clients = new Map<string, number>(); // cid → lastSeenMs
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private readonly now: () => number;
  private readonly subscriptionsChanged: () => void;
  private readonly onExpire: (cid: string) => void;

  constructor(opts: EventPollHubOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.subscriptionsChanged = opts.subscriptionsChanged ?? (() => {});
    this.onExpire = opts.onExpire ?? (() => {});
  }

  // ── broadcast buffer ───────────────────────────────────────────────────

  /**
   * Remember a broadcast for the poll clients to collect.
   *
   * A no-op with no poll clients attached: recording would force a
   * `JSON.stringify` of every broadcast on an appliance that has none, and the
   * SSE fan-out deliberately serializes only when somebody wants the frame.
   * A client that attaches later is caught up by the snapshot instead.
   */
  record(channel: string, payload: unknown, serialized?: string): void {
    if (this.clients.size === 0) return;
    const atMs = this.now();
    this.buffer.push({ seq: ++this.lastSeq, channel, serialized: serialized ?? JSON.stringify(payload), atMs });
    this.trim(atMs);
  }

  private trim(nowMs: number): void {
    const oldestAllowed = nowMs - BUFFER_MAX_AGE_MS;
    let drop = 0;
    while (drop < this.buffer.length && this.buffer[drop].atMs < oldestAllowed) drop++;
    if (this.buffer.length - drop > BUFFER_MAX_FRAMES) drop = this.buffer.length - BUFFER_MAX_FRAMES;
    if (drop > 0) this.buffer.splice(0, drop);
  }

  /** For tests: how many frames are held right now. */
  bufferSize(): number {
    // Age-trim on read as well as on write, so a buffer that stopped receiving
    // does not report frames a poll would refuse to replay.
    this.trim(this.now());
    return this.buffer.length;
  }

  /** The newest sequence number issued. */
  currentSeq(): number {
    return this.lastSeq;
  }

  /**
   * What a client asking from `since` should receive.
   *
   * `since == null` is "I have nothing" — the snapshot, and no resync flag
   * because nothing was lost. A `since` the buffer no longer covers gets the
   * same frames with `resync: true` so the client knows to drop its position.
   * A `since` AHEAD of what this process has issued gets one too: that is a
   * client whose server restarted and reset the counter, which would otherwise
   * sit on an empty response forever. So does a cid that had expired and come
   * back, whose `since` can look current while it is anything but.
   */
  buildPollResponse(
    cid: string,
    since: number | null,
    wants: (channel: string) => boolean,
    snapshot: () => PollFrame[],
  ): PollResponse {
    const returning = this.touch(cid);
    this.trim(this.now());

    const oldest = this.buffer.length > 0 ? this.buffer[0].seq : this.lastSeq + 1;
    if (since == null) {
      return { seq: this.lastSeq, resync: false, frames: snapshot().filter((f) => wants(f.channel)) };
    }
    // `returning` is the case the sequence numbers cannot see. record() is a
    // no-op with no clients attached, so while this cid was expired the counter
    // did not move — a client coming back with the last seq it saw looks
    // perfectly up to date, and would be answered with an empty frame list
    // forever while the service ran on without it. The registry is the only
    // thing that knows a gap happened.
    if (returning || since + 1 < oldest || since > this.lastSeq) {
      return { seq: this.lastSeq, resync: true, frames: snapshot().filter((f) => wants(f.channel)) };
    }
    const frames: PollFrame[] = [];
    for (const f of this.buffer) {
      if (f.seq > since && wants(f.channel)) frames.push({ channel: f.channel, serialized: f.serialized });
    }
    return { seq: this.lastSeq, resync: false, frames };
  }

  // ── client registry ────────────────────────────────────────────────────

  /**
   * Record that `cid` is alive.
   *
   * @returns true when this cid was NOT in the registry — a first sight, or a
   * return after expiry. The caller needs the difference: a returning client
   * missed everything broadcast while it was gone, and nothing in the sequence
   * numbers says so.
   */
  touch(cid: string): boolean {
    const known = this.clients.has(cid);
    this.clients.set(cid, this.now());
    if (known) return false;
    console.log(`[events] poll client ${scrub(cid)} started`);
    this.startSweep();
    this.subscriptionsChanged();
    return true;
  }

  /** Live poll-client ids, for the subscriber accounting in remote-server. */
  clientIds(): string[] {
    return [...this.clients.keys()];
  }

  /** For tests: is the expiry sweep armed? */
  sweepRunning(): boolean {
    return this.sweepTimer !== null;
  }

  /** Expire anything that has gone quiet. Public so a test drives it directly
   *  rather than waiting out a real interval. */
  sweep(): void {
    const cutoff = this.now() - POLL_CLIENT_TTL_MS;
    let expired = 0;
    for (const [cid, seen] of this.clients) {
      if (seen > cutoff) continue;
      this.clients.delete(cid);
      this.onExpire(cid);
      expired++;
      // The duration is spelled out rather than interpolated: log-injection's
      // scan cannot tell a constant from wire data and rejects any unscrubbed
      // interpolation, which is the right default. TTL_IS_30S below is what
      // stops the two drifting.
      console.log(`[events] poll client ${scrub(cid)} expired (no poll for 30s)`);
    }
    if (this.clients.size === 0) {
      this.stopSweep();
      // Nothing is collecting any more, so held frames are only memory.
      this.buffer.length = 0;
    }
    if (expired > 0) this.subscriptionsChanged();
  }

  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Public so a shutting-down server, or a test, leaves no timer behind. */
  stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
