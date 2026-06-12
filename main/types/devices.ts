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

export interface DeviceStatus {
  channelId: string;
  name: string | null;
  deviceType: "receiver" | "iem" | "charger" | string;
  online: boolean;
  rfBars: number | null;
  rfLevelDbm: number | null;
  battery: number | null;
  charging: boolean | null;
  frequencyLabel: string | null;
  audioLevel: number | null;
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
