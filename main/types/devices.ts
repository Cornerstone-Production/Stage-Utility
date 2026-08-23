// Normalized device types — brand-agnostic shapes that every DeviceProvider emits.

import type { ConfigField, ConnectionState } from "./integrations.js";

export interface WirelessConnection {
  id: string;
  name: string;
  providerId: string;
  enabled: boolean;
  /** Runtime-only: current connection state. */
  connection: ConnectionState;
  /** Runtime-only: informational message (e.g. error text or stub notice). */
  message: string | null;
  /** Provider-specific configuration. */
  config: Record<string, unknown>;
}

/**
 * The SSE channel carrying live per-channel wireless telemetry.
 *
 * Named here rather than at either end so the server that broadcasts it and the
 * hook that subscribes cannot drift apart on a string literal — which is how
 * the wireless widgets ended up pointed at a picker endpoint in the first place.
 */
export const WIRELESS_STATUS_CHANNEL = "wireless:channels";

export interface DeviceStatus {
  channelId: string;
  name: string | null;
  deviceType: "receiver" | "iem" | "charger" | string;
  online: boolean;
  rfBars: number | null;
  rfLevelDbm: number | null;
  battery: number | null;
  /** Battery runtime remaining, in whole minutes, when the device computes one.
   *  Percentage answers "how full"; this answers "will it last the service",
   *  which is the question Wireless Workbench puts on screen and the one an
   *  operator is actually asking. Null where the gear does not report it — a
   *  charge percentage is NOT a substitute, because runtime depends on the pack
   *  and the transmit power. */
  batteryMinutes: number | null;
  charging: boolean | null;
  frequencyLabel: string | null;
  audioLevel: number | null;
  /** Charger-bay telemetry (SBC-series chargers). null/absent for mics & IEMs. */
  cycles: number | null;
  health: number | null;
  tempC: number | null;
  updatedAt: string;
}

export interface DeviceChannel {
  id: string;
  label: string;
}

export interface DeviceProvider {
  readonly id: string;
  readonly label: string;
  readonly configSchema: ConfigField[];
  connect(cfg: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  listChannels(): Promise<DeviceChannel[]>;
  onStatus(cb: (s: DeviceStatus) => void): void;
  /** Register a callback that fires whenever the provider's connection state transitions. */
  onConnectionStateChange(cb: (state: ConnectionState) => void): void;
  getConnectionState(): ConnectionState;
}
