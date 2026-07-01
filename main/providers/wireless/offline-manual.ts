// OfflineManualProvider — non-networked gear (e.g. a Shure PSM 900 IEM pack or an
// older mic with no Ethernet). It never connects to anything and emits no live
// telemetry; it simply exposes a set of USER-NAMED channels so they can be bound
// to a slot's mic or IEM and shown as a plain label (no RF/battery bars).
//
// Each configured name becomes a channel; on connect we emit one DeviceStatus per
// channel (deviceType "manual", online:false, all telemetry null, `name` set) so
// the existing status pipeline carries the label through to the slot resolver.

import type { DeviceChannel, DeviceProvider, DeviceStatus } from "../../types/devices.js";
import type { ConfigField, ConnectionState } from "../../types/integrations.js";

/** Pull the trimmed, non-empty device names out of a connection config. */
function parseNames(cfg: Record<string, unknown>): string[] {
  const raw = cfg.names;
  if (!Array.isArray(raw)) return [];
  return raw.map((n) => (typeof n === "string" ? n.trim() : "")).filter((n) => n.length > 0);
}

export class OfflineManualProvider implements DeviceProvider {
  readonly id = "offline-manual";
  readonly label = "Offline / Manual devices";
  readonly configSchema: ConfigField[] = [];

  private names: string[] = [];
  private statusCb: ((s: DeviceStatus) => void) | null = null;

  async connect(cfg: Record<string, unknown>): Promise<void> {
    this.names = parseNames(cfg);
    // Emit a label-only status for each named device so the resolver can render it.
    const now = new Date().toISOString();
    this.names.forEach((name, i) => {
      this.statusCb?.({
        channelId: String(i + 1),
        name,
        deviceType: "manual",
        online: false,
        rfBars: null,
        rfLevelDbm: null,
        battery: null,
        charging: null,
        frequencyLabel: null,
        audioLevel: null,
        cycles: null,
        health: null,
        tempC: null,
        updatedAt: now,
      });
    });
  }

  async disconnect(): Promise<void> {
    // Nothing to tear down — no socket, no timers.
  }

  async listChannels(): Promise<DeviceChannel[]> {
    return this.names.map((name, i) => ({ id: String(i + 1), label: name }));
  }

  onStatus(cb: (s: DeviceStatus) => void): void {
    this.statusCb = cb;
  }

  onConnectionStateChange(_cb: (state: ConnectionState) => void): void {
    // Never transitions — there's nothing to connect to.
  }

  getConnectionState(): ConnectionState {
    // Honest state: not connected to any device. Channels + labels still work
    // regardless of this (they're config-driven, not connection-driven).
    return "disconnected";
  }
}
