// NoneProvider — the default wireless provider. It is inert: no TCP connections,
// no data emitted. Selecting it leaves the connection in "disconnected" state.

import type { DeviceChannel, DeviceProvider, DeviceStatus } from "../../types/devices.js";
import type { ConfigField, ConnectionState } from "../../types/integrations.js";

export class NoneProvider implements DeviceProvider {
  readonly id = "none";
  readonly label = "None";
  readonly configSchema: ConfigField[] = [];

  async connect(_cfg: Record<string, unknown>): Promise<void> {
    // No-op: NoneProvider never connects.
  }

  async disconnect(): Promise<void> {
    // No-op.
  }

  async listChannels(): Promise<DeviceChannel[]> {
    return [];
  }

  onStatus(_cb: (s: DeviceStatus) => void): void {
    // Never emits.
  }

  onConnectionStateChange(_cb: (state: ConnectionState) => void): void {
    // Never transitions — inert placeholder.
  }

  getConnectionState(): ConnectionState {
    return "disconnected";
  }
}
