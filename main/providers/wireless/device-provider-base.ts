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
  /** Charger-bay telemetry (null for mics and IEMs). */
  cycles: number | null;
  health: number | null;
  tempC: number | null;
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
    cycles: null,
    health: null,
    tempC: null,
  };
}

/** The SSE channel the wireless panel listens on — see reconnectDelayMs. */
const WIRELESS_CHANNEL = "wireless:connections-changed";

export abstract class DeviceProviderBase {
  private statusCb: ((s: DeviceStatus) => void) | null = null;
  private connCb: ((state: ConnectionState) => void) | null = null;
  private connState: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Is a retry already queued? */
  protected get reconnectPending(): boolean {
    return this.reconnectTimer !== null;
  }
}
