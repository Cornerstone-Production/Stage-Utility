// DeviceManager — manages MULTIPLE provider instances, one per wireless
// connection. Channels from all connected providers are namespaced as
// `${connectionId}::${providerChannelId}` before reaching StageController.

import { errorMessage } from "./errors.js";
import type { DeviceProvider } from "../types/devices.js";
import type { WirelessConnection } from "../types/devices.js";
import type { ConnectionState } from "../types/integrations.js";
import { providerRegistry } from "../providers/registry.js";
import { stageController } from "./stage-controller.js";

interface RuntimeEntry {
  provider: DeviceProvider;
  connectionId: string;
  connectionName: string;
}

export class DeviceManager {
  // connectionId → live provider entry
  private entries = new Map<string, RuntimeEntry>();

  // Global metering/polling interval (ms) applied to every provider on connect.
  private meterRateMs = 1000;

  // Optional listener notified whenever a provider's connection state changes.
  private connectionStateListener:
    | ((connId: string, state: ConnectionState) => void)
    | null = null;

  /** Register a listener for async connection-state transitions. */
  setConnectionStateListener(
    cb: (connId: string, state: ConnectionState) => void,
  ): void {
    this.connectionStateListener = cb;
  }

  /** Set the global metering interval. Takes effect for connections opened after this. */
  setMeterRate(ms: number): void {
    this.meterRateMs = Math.max(0, Math.floor(ms));
    console.log(`[device-manager] meter rate set to ${this.meterRateMs}ms`);
  }

  async start(): Promise<void> {
    console.log("[device-manager] start");
  }

  async stop(): Promise<void> {
    console.log("[device-manager] stop — disconnecting all connections");
    await this.disconnectAll();
  }

  /**
   * Reconcile live provider instances to match the given enabled connections.
   * - Connections added/changed: connect the new provider.
   * - Connections removed or disabled: disconnect + drop.
   * - Stub providers (no driver): do NOT connect; leave runtime status as-is
   *   (caller sets message = "driver arrives in a future update").
   *
   * Mutates the `connection` and `message` fields of each WirelessConnection
   * in-place so callers can read updated runtime state immediately.
   */
  async applyConnections(connections: WirelessConnection[]): Promise<void> {
    console.log(`[device-manager] applyConnections — ${connections.length} connection(s)`);

    // Publish connectionId→name so charger bays can be labeled by the user's
    // connection name (unambiguous) rather than an arbitrary sort-order index.
    stageController.setConnectionNames(new Map(connections.map((c) => [c.id, c.name])));

    // Determine which connection ids should be active.
    const enabledWithDriver = new Set<string>();
    for (const conn of connections) {
      if (conn.enabled && providerRegistry.hasDriver(conn.providerId)) {
        enabledWithDriver.add(conn.id);
      }
    }

    // Disconnect entries that are no longer needed.
    for (const [id, entry] of this.entries) {
      if (!enabledWithDriver.has(id)) {
        console.log(`[device-manager] disconnecting removed/disabled connection: ${id}`);
        try {
          await entry.provider.disconnect();
        } catch (err) {
          console.error(`[device-manager] disconnect error for ${id}:`, err);
        }
        this.entries.delete(id);
      }
    }

    // Connect new/updated enabled connections.
    for (const conn of connections) {
      if (!conn.enabled) {
        // Disabled — ensure disconnected (already handled above if it was active).
        conn.connection = "disconnected";
        conn.message = null;
        continue;
      }

      if (!providerRegistry.hasDriver(conn.providerId)) {
        // Stub provider — report informational message, no connection attempt.
        const desc = providerRegistry.getDescriptor(conn.providerId);
        conn.connection = "disconnected";
        conn.message = `${desc?.label ?? conn.providerId}: driver arrives in a future update`;
        continue;
      }

      // Real driver — check if already connected with the same config.
      const existing = this.entries.get(conn.id);
      if (existing) {
        // Already connected; update name in case it changed.
        existing.connectionName = conn.name;
        conn.connection = existing.provider.getConnectionState();
        conn.message = null;
        continue;
      }

      // New connection — create a fresh provider instance and connect.
      const provider = providerRegistry.createProvider(conn.providerId);
      if (!provider) {
        conn.connection = "error";
        conn.message = `Failed to create provider: ${conn.providerId}`;
        continue;
      }

      const connectionId = conn.id;
      const connectionName = conn.name;

      // Namespace channelIds before forwarding to StageController.
      provider.onStatus((status) => {
        const namespacedId = `${connectionId}::${status.channelId}`;
        stageController.applyDeviceStatus(namespacedId, { ...status, channelId: namespacedId });
      });

      // Forward async connection-state changes to WirelessManager.
      provider.onConnectionStateChange((newState) => {
        // Keep the in-memory WirelessConnection list consistent.
        const liveConn = connections.find((c) => c.id === connectionId);
        if (liveConn) liveConn.connection = newState;
        this.connectionStateListener?.(connectionId, newState);
      });

      conn.connection = "connecting";
      conn.message = null;

      try {
        await provider.connect({ ...conn.config, meterRateMs: this.meterRateMs });
        this.entries.set(connectionId, { provider, connectionId, connectionName });
        conn.connection = provider.getConnectionState();
        conn.message = null;
        console.log(`[device-manager] connected: ${connectionId} (${conn.name})`);
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[device-manager] connect error for ${connectionId}:`, msg);
        conn.connection = "error";
        conn.message = `Connection failed: ${msg}`;
      }
    }
  }

  /** Aggregate channels from all connected real-driver providers. */
  async listChannels(): Promise<{ id: string; label: string }[]> {
    const results: { id: string; label: string }[] = [];
    for (const entry of this.entries.values()) {
      try {
        const channels = await entry.provider.listChannels();
        for (const ch of channels) {
          results.push({
            id: `${entry.connectionId}::${ch.id}`,
            label: `${entry.connectionName} — ${ch.label}`,
          });
        }
      } catch (err) {
        console.error(`[device-manager] listChannels error for ${entry.connectionId}:`, err);
      }
    }
    return results;
  }

  /** Summary connection state: "connected" if ANY entry is connected. */
  getConnectionState(): ConnectionState {
    if (this.entries.size === 0) return "disconnected";
    for (const entry of this.entries.values()) {
      if (entry.provider.getConnectionState() === "connected") return "connected";
    }
    return "disconnected";
  }

  private async disconnectAll(): Promise<void> {
    for (const [id, entry] of this.entries) {
      try {
        await entry.provider.disconnect();
      } catch (err) {
        console.error(`[device-manager] disconnect error for ${id}:`, err);
      }
    }
    this.entries.clear();
  }
}

export const deviceManager = new DeviceManager();
