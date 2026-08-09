// WirelessManager — manages multiple wireless connections (config + runtime).
// Config persisted via wirelessStore; runtime fields (connection/message) are
// in-memory only. Broadcasts "wireless:connections-changed" on every mutation.

import { randomUUID } from "crypto";

import { scrub } from "./scrub.js";

import type { WirelessConnection } from "../types/devices.js";
import type { ConnectionState, IntegrationDescriptor } from "../types/integrations.js";
import { providerRegistry } from "../providers/registry.js";
import { broadcast } from "./broadcaster.js";
import { deviceManager } from "./device-manager.js";
import { secretsStore } from "./secrets.js";
import { settingsStore } from "./settings-store.js";
import { credentialKeys, mergeSecrets, publicConfig, splitConfig, withSecrets } from "./wireless-credentials.js";
import { wirelessStore } from "./wireless-store.js";

/** The fastest metering interval worth allowing. Below this the polling costs
 *  more than the freshness is worth, and 0 is a busy loop. */
const MIN_METER_RATE_MS = 100;

class WirelessManager {
  // In-memory list of connections including runtime fields.
  private connections: WirelessConnection[] = [];
  // Global metering/polling interval (ms) applied to all wireless gear.
  private meterRateMs = 1000;

  // ── Init ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    console.log("[wireless] init");
    const settings = await settingsStore.load();
    this.meterRateMs = settings.wirelessMeterRateMs ?? 1000;
    deviceManager.setMeterRate(this.meterRateMs);

    const configs = await wirelessStore.load();

    // Hydrate with default runtime fields, and fold each connection's credentials
    // back in from the encrypted store — the drivers need the real password, only
    // the persisted file and the API surface go without it.
    this.connections = await Promise.all(
      configs.map(async (cfg) => ({
        ...cfg,
        config: withSecrets(cfg.config, await secretsStore.getSecrets(WirelessManager.secretId(cfg.id))),
        connection: "disconnected" as const,
        message: null,
      })),
    );

    // One-time migration for a box upgrading from when passwords lived in
    // wireless-connections.json. Without this the cleartext stays in that file —
    // and therefore in every config snapshot — until someone happens to edit the
    // connection. persist() moves it into the encrypted store and rewrites the
    // file without it.
    const legacy = configs.filter((cfg) => credentialKeys(cfg.providerId).some((k) => cfg.config[k]));
    if (legacy.length > 0) {
      console.log(`[wireless] migrating ${legacy.length} stored credential(s) out of wireless-connections.json`);
      await this.persist();
    }

    // Apply all connections (connects enabled real-driver ones, sets stub messages).
    await deviceManager.applyConnections(this.connections);

    // Wire async state-change notifications from the device layer.
    deviceManager.setConnectionStateListener((connId, state) => {
      this.patchRuntimeState(connId, state);
      this.broadcast();
    });

    console.log(`[wireless] init complete — ${this.connections.length} connection(s), meterRate=${this.meterRateMs}ms`);
  }

  // ── Metering interval ───────────────────────────────────────────────────

  getMeterRate(): number {
    return this.meterRateMs;
  }

  async setMeterRate(ms: number): Promise<{ ms: number }> {
    // Floored, not just made non-negative. The route accepts any number >= 0,
    // and 0 has no meaning here — it becomes setInterval(poll, 0), a busy loop
    // that pegs a core on a Pi and floods the LAN with device polls.
    const next = Math.max(MIN_METER_RATE_MS, Math.floor(ms));
    console.log(`[wireless] setMeterRate → ${next}ms`);
    this.meterRateMs = next;
    await settingsStore.patch({ wirelessMeterRateMs: next });
    deviceManager.setMeterRate(next);
    // Reconnect all gear so the new metering interval takes effect immediately.
    await deviceManager.stop();
    await deviceManager.applyConnections(this.connections);
    this.broadcast();
    return { ms: next };
  }

  /** Re-apply connections without reloading from disk (use after master toggle). */
  async reapply(): Promise<void> {
    console.log("[wireless] reapply");
    await deviceManager.applyConnections(this.connections);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  listProviders(): IntegrationDescriptor[] {
    return providerRegistry.getDescriptors();
  }

  /**
   * The connections as a client may see them — credentials masked.
   *
   * This is the API and SSE surface (GET /api/wireless/connections and every
   * wireless:connections-changed broadcast), so the real password must not be in
   * it. The UI used to mask on arrival, which meant the cleartext had already
   * crossed the LAN to get there.
   */
  listConnections(): WirelessConnection[] {
    return this.connections.map((c) => ({ ...c, config: publicConfig(c.providerId, c.config) }));
  }

  async addConnection(params: { name?: string; providerId?: string }): Promise<WirelessConnection[]> {
    const index = this.connections.length + 1;
    const conn: WirelessConnection = {
      id: randomUUID(),
      name: params.name?.trim() || `Connection ${index}`,
      providerId: params.providerId ?? "none",
      enabled: false,
      connection: "disconnected",
      message: null,
      config: {},
    };

    console.log(`[wireless] addConnection — ${scrub(conn.id)} (${scrub(conn.name)}, provider=${scrub(conn.providerId)})`);
    this.connections.push(conn);
    await this.persist();
    await deviceManager.applyConnections(this.connections);
    this.broadcast();
    return this.listConnections();
  }

  async updateConnection(params: {
    id: string;
    patch: Partial<Pick<WirelessConnection, "name" | "providerId" | "enabled" | "config">>;
  }): Promise<WirelessConnection[]> {
    const idx = this.connections.findIndex((c) => c.id === params.id);
    if (idx === -1) throw new Error(`wireless:updateConnection — unknown id: ${params.id}`);

    const conn = this.connections[idx];
    const patch = params.patch;

    if (patch.name !== undefined) conn.name = patch.name.trim() || conn.name;
    if (patch.providerId !== undefined) conn.providerId = patch.providerId;
    if (patch.enabled !== undefined) conn.enabled = patch.enabled;
    if (patch.config !== undefined) {
      // The form posts back the mask it was shown, so a patch that only changes
      // the IP still carries "••••" in the password field. Merging that verbatim
      // would hand the driver the mask as its password. mergeSecrets resolves it
      // against what is stored: mask keeps, "" clears, anything else replaces.
      const stored = await secretsStore.getSecrets(WirelessManager.secretId(conn.id));
      const merged = mergeSecrets(conn.providerId, patch.config, stored);
      conn.config = withSecrets({ ...conn.config, ...splitConfig(conn.providerId, patch.config).safe }, merged);
    }

    console.log(`[wireless] updateConnection — ${conn.id} patch keys: ${Object.keys(patch).join(", ")}`);
    await this.persist();
    await deviceManager.applyConnections(this.connections);
    this.broadcast();
    return this.listConnections();
  }

  async removeConnection(params: { id: string }): Promise<WirelessConnection[]> {
    const idx = this.connections.findIndex((c) => c.id === params.id);
    if (idx === -1) throw new Error(`wireless:removeConnection — unknown id: ${params.id}`);

    console.log(`[wireless] removeConnection — ${params.id}`);
    this.connections.splice(idx, 1);
    await this.persist();
    // applyConnections reconciles — the removed entry will be disconnected.
    await deviceManager.applyConnections(this.connections);
    this.broadcast();
    return this.listConnections();
  }

  async testConnection(params: { id: string }): Promise<{ ok: boolean; message?: string }> {
    const conn = this.connections.find((c) => c.id === params.id);
    if (!conn) throw new Error(`wireless:testConnection — unknown id: ${params.id}`);

    if (conn.providerId === "none") {
      return { ok: true, message: "No hardware driver — placeholder connection" };
    }

    if (!providerRegistry.hasDriver(conn.providerId)) {
      const desc = providerRegistry.getDescriptor(conn.providerId);
      return {
        ok: false,
        message: `${desc?.label ?? conn.providerId}: driver arrives in a future update`,
      };
    }

    // Real driver — report current connection state.
    return {
      ok: true,
      message: `Provider available (state: ${conn.connection ?? "unknown"})`,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Update a single connection's runtime state without reloading from disk. */
  private patchRuntimeState(connId: string, state: ConnectionState): void {
    const conn = this.connections.find((c) => c.id === connId);
    if (!conn) return;
    conn.connection = state;
    // Clear transient error message once the connection recovers.
    if (state === "connected" || state === "disconnected") conn.message = null;
  }

  /** The secrets slot for one connection. Per-connection: two Spectera base
   *  stations are two different passwords. */
  private static secretId(connId: string): string {
    return `wireless:${connId}`;
  }

  private async persist(): Promise<void> {
    // Credentials never reach wireless-connections.json — that file is in
    // CONFIG_FILES, so anything left in it lands in every config snapshot the
    // operator downloads, which the snapshot promises does not happen.
    const rows = [];
    for (const { id, name, providerId, enabled, config } of this.connections) {
      const slot = WirelessManager.secretId(id);
      const stored = await secretsStore.getSecrets(slot);
      await secretsStore.setSecrets(slot, mergeSecrets(providerId, config, stored));
      rows.push({ id, name, providerId, enabled, config: splitConfig(providerId, config).safe });
    }
    await wirelessStore.save(rows);
  }

  private broadcast(): void {
    broadcast("wireless:connections-changed", this.listConnections());
  }
}

export const wirelessManager = new WirelessManager();
