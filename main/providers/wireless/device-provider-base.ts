// device-provider-base.ts — the lifecycle every wireless driver shares.
//
// Shure, Sennheiser SSC (ewG4 / EW-DX) and Spectera speak three unrelated
// protocols — ASCII over TCP, JSON over UDP, JSON over HTTPS+SSE — but each had
// independently grown the same surrounding machinery: the two callbacks the
// device manager registers, a connection state that must only be reported when it
// CHANGES, a reconnect timer, and the fourteen-field DeviceStatus literal.
//
// The copies had already drifted in ways that mattered. The Spectera channel
// struct silently lost five telemetry fields — all still present in its payload,
// pinned to null, so the type checker was satisfied and a pack simply reported no
// charge state. And NONE of the three passed `forceActive` to capDelayMs, so a
// receiver that dropped stayed on the dormant reconnect ceiling — up to an hour —
// even while an operator sat watching the wireless panel waiting for it.
//
// What stays per-driver is the transport and the parsing. This owns only the
// bookkeeping around it.

import type { ConnectionState } from "../../types/integrations.js";
import type { DeviceStatus } from "../../types/devices.js";
import { channelHasSubscribers } from "../../services/broadcaster.js";
import { serviceWindow } from "../../services/service-window.js";
import { cleared } from "../../services/timers.js";
import { OutageLog } from "../../services/repeat-log.js";

/**
 * Per-channel telemetry, shared by every driver.
 *
 * One definition on purpose: this existed three times, and the third copy had
 * quietly dropped five fields. A driver that cannot source a field leaves it
 * null — which is the honest answer and what the UI renders as a dash.
 */
export interface ChannelState {
  channelId: string;
  name: string | null;
  deviceType: "receiver" | "iem" | "charger";
  online: boolean;
  rfBars: number | null;
  rfLevelDbm: number | null;
  battery: number | null;
  /** Runtime remaining in whole minutes, where the gear computes one. */
  batteryMinutes: number | null;
  charging: boolean | null;
  frequencyLabel: string | null;
  audioLevel: number | null;
  /** The channel is muted — at the receiver, or at the pack. A muted pack still
   *  reports five bars and a full battery, so without this it looks perfect on a
   *  stage display while nothing comes out of it. */
  muted: boolean | null;
  /** Channel quality 0-5. NOT signal strength: it accounts for interference, so a
   *  pack can sit at five bars of RF with a quality of two. It is the figure
   *  Wireless Workbench leads with. */
  quality: number | null;
  /** The receiver is reporting RF interference on this channel. */
  interference: boolean | null;
  /** Charger-bay telemetry (null for mics and IEMs). */
  cycles: number | null;
  health: number | null;
  tempC: number | null;
  /** Minutes until the docked pack is charged, where the charger computes one.
   *  Null on a bay that is already full, empty or faulted — the charger answers
   *  "not applicable" there, and a zero would read as "ready now". */
  timeToFullMinutes: number | null;
  /** A short operator-readable fault on this bay/channel, e.g. "Error 007". The
   *  only signal a bay or its battery is bad: a faulted bay still reports a
   *  battery as DOCKED, so without this it renders as an ordinary occupied bay. */
  fault: string | null;
  /** The charger is in storage mode: it charges to about 40% and stops. Without
   *  it an operator sees 40% and no charging indicator and has no way to know
   *  why. Device-level, mirrored onto every bay. Null where not applicable. */
  storageMode: boolean | null;
}

/** A blank channel: everything unknown until the device says otherwise. */
export function blankChannel(
  channelId: string,
  opts: { name?: string | null; deviceType?: ChannelState["deviceType"] } = {},
): ChannelState {
  return {
    channelId,
    name: opts.name ?? null,
    deviceType: opts.deviceType ?? "receiver",
    online: false,
    rfBars: null,
    rfLevelDbm: null,
    battery: null,
    batteryMinutes: null,
    charging: null,
    frequencyLabel: null,
    audioLevel: null,
    muted: null,
    quality: null,
    interference: null,
    cycles: null,
    health: null,
    tempC: null,
    timeToFullMinutes: null,
    fault: null,
    storageMode: null,
  };
}

/** The SSE channel the wireless panel listens on — see reconnectDelayMs. */
const WIRELESS_CHANNEL = "wireless:connections-changed";

export abstract class DeviceProviderBase {
  private statusCb: ((s: DeviceStatus) => void) | null = null;
  private connCb: ((state: ConnectionState) => void) | null = null;
  private connState: ConnectionState = "disconnected";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly intervals = new Map<string, NodeJS.Timeout>();
  private watchdog: NodeJS.Timeout | null = null;
  private readonly outages = new OutageLog();

  /** The tag every line from this driver starts with, e.g. `[shure:shure-ulxd]`. */
  protected abstract logTag(): string;

  onStatus(cb: (s: DeviceStatus) => void): void {
    this.statusCb = cb;
  }

  onConnectionStateChange(cb: (state: ConnectionState) => void): void {
    this.connCb = cb;
  }

  getConnectionState(): ConnectionState {
    return this.connState;
  }

  /** Report a connection state, but only when it actually changed. */
  protected setState(s: ConnectionState): void {
    if (s === this.connState) return;
    this.connState = s;
    this.connCb?.(s);
  }

  /** Push one channel's telemetry to the device manager. */
  protected emitStatus(st: ChannelState): void {
    this.statusCb?.({ ...st, updatedAt: new Date().toISOString() });
  }

  /** Mark every channel offline and report it — a socket closing, a stop().
   *  One name and one shape for all three drivers. */
  protected offlineAll(channels: Iterable<ChannelState>): void {
    for (const st of channels) {
      st.online = false;
      this.emitStatus(st);
    }
  }

  /**
   * Clamp a retry delay to the service window.
   *
   * `forceActive` is the part every driver was missing. capDelayMs otherwise
   * clamps to the DORMANT ceiling outside a service window — up to an hour —
   * which is right for gear nobody is looking at and wrong the moment an operator
   * opens the wireless panel to find out why a pack went dark. Subscribers on the
   * wireless channel mean someone is watching, so the retry stays brisk.
   */
  protected reconnectDelayMs(rawMs: number): number {
    return serviceWindow.capDelayMs(rawMs, channelHasSubscribers(WIRELESS_CHANNEL));
  }

  /** Queue `fn` after `rawMs`, clamped. A retry already pending wins.
   *  Named distinctly from each driver's own scheduleReconnect so an override
   *  cannot silently shadow it. */
  protected queueReconnect(rawMs: number, fn: () => void): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      fn();
    }, this.reconnectDelayMs(rawMs));
  }

  protected clearReconnect(): void {
    this.reconnectTimer = cleared(this.reconnectTimer);
  }

  /** Is a retry already queued? */
  protected get reconnectPending(): boolean {
    return this.reconnectTimer !== null;
  }

  // ── Timers that belong to one link ──────────────────────────────────────────
  //
  // Held here, not by each driver, because a driver-held one is a timer only that
  // driver remembers to stop. The Shure charger's 30 s bay poll was exactly that:
  // created in its onConnected(), never cleared, so removing a charger connection
  // left an interval holding the discarded provider for the life of the process.
  // A driver asks for a timer by name; stopLinkTimers() ends every one of them.

  /** Run `fn` every `ms` while this link is up. A second call under the same
   *  `name` replaces the first, so a reconnect cannot stack two. */
  protected every(name: string, ms: number, fn: () => void): void {
    const prev = this.intervals.get(name);
    if (prev) clearInterval(prev);
    this.intervals.set(name, setInterval(fn, ms));
  }

  /**
   * (Re)arm the silence watchdog: `onSilent` runs if nothing re-arms it within
   * `ms`. Re-arm on every sign of life from the device. One per provider: a link
   * has one "is anyone there" question.
   */
  protected armWatchdog(ms: number, onSilent: () => void): void {
    this.watchdog = cleared(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      onSilent();
    }, ms);
  }

  /** Stop the link's timers: every interval and the watchdog. Not a queued
   *  retry — that belongs to the next link, and a socket closing is exactly when
   *  one gets queued. */
  protected stopLinkTimers(): void {
    for (const t of this.intervals.values()) clearInterval(t);
    this.intervals.clear();
    this.watchdog = cleared(this.watchdog);
  }

  /** Everything, a queued retry included. For disconnect(). */
  protected stopAllTimers(): void {
    this.stopLinkTimers();
    this.clearReconnect();
  }

  // ── Saying a link failed ────────────────────────────────────────────────────
  //
  // Once per OUTAGE, through the shared OutageLog (services/repeat-log.ts): the
  // first failure of a run, the first of each new kind, a reminder every 15
  // minutes, and one line when the link has held again. Not under a debug
  // variable: Spectera and SSC used to write their failures only under
  // SPECTERA_DEBUG / SENNHEISER_DEBUG, so a wrong password or a wrong address
  // left the panel saying "error" and /log saying nothing.

  /**
   * Report a failure. `kind` separates problems that must not hide one another
   * (a refused password, then an unreachable host). `key` separates failures
   * that are not the link's — a frame the driver could not read is not an
   * outage, and must not end or extend one. `message` is the operator's line,
   * without the tag; every device- or operator-supplied value in it is scrubbed
   * by the caller.
   */
  protected reportFailure(kind: string, message: string, key = "link"): void {
    const d = this.outages.fail(key, kind, Date.now());
    if (d.log) console.warn(`${this.logTag()} ${message}${d.note}`);
  }

  /** The link is working: the device sent something. Cheap enough to call on
   *  every chunk, and ends a run only once it has held. */
  protected reportWorking(key = "link"): void {
    const d = this.outages.ok(key, Date.now());
    if (d.log) console.log(`${this.logTag()} working again${d.note}`);
  }

  /** A new configuration: nothing learned about the old address or password is
   *  true of the new one, so the next failure is news. */
  protected forgetFailures(): void {
    this.outages.forget();
  }
}
