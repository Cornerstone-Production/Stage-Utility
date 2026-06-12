// IntegrationManager — registry for all integrations (PCO, Wireless, Companion).
// Holds descriptors + config + state; persist non-secret via settingsStore,
// secrets via secretsStore; broadcasts "integrations:state-changed".

import type { IntegrationDescriptor, IntegrationState } from "../types/integrations.js";
import { broadcast } from "./broadcaster.js";
import { secretsStore } from "./secrets.js";
import { settingsStore } from "./settings-store.js";
import { stageController } from "./stage-controller.js";
import { wirelessManager } from "./wireless-manager.js";

// PCO integration descriptor.
const PCO_DESCRIPTOR: IntegrationDescriptor = {
  id: "planning-center",
  kind: "lineup",
  label: "Planning Center",
  configSchema: [
    {
      key: "appId",
      label: "App ID",
      type: "text",
      placeholder: "your-app-id",
    },
    {
      key: "secret",
      label: "Secret",
      type: "password",
      placeholder: "your-secret",
    },
  ],
};

// Wireless integration descriptor — master enable toggle only.
// Per-connection config is managed via wireless:* IPC handlers.
const WIRELESS_DESCRIPTOR: IntegrationDescriptor = {
  id: "wireless",
  kind: "wireless",
  label: "Wireless Gear",
  configSchema: [],
};

// Companion integration descriptor (future use, control endpoints already exist).
const COMPANION_DESCRIPTOR: IntegrationDescriptor = {
  id: "companion",
  kind: "control",
  label: "Bitfocus Companion",
  configSchema: [
    {
      key: "host",
      label: "Companion Host",
      type: "text",
      placeholder: "192.168.1.50",
    },
    {
      key: "port",
      label: "Port",
      type: "number",
      placeholder: "8888",
    },
  ],
};

const DESCRIPTORS: IntegrationDescriptor[] = [
  PCO_DESCRIPTOR,
  WIRELESS_DESCRIPTOR,
  COMPANION_DESCRIPTOR,
];

// Keys that are secrets for each integration id.
const SECRET_KEYS: Record<string, string[]> = {
  "planning-center": ["secret"],
  wireless: [],
  companion: [],
};

class IntegrationManager {
  private states = new Map<string, IntegrationState>();

  // ── Init ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    console.log("[integration-manager] init");
    const settings = await settingsStore.load();

    for (const descriptor of DESCRIPTORS) {
      const savedConfig = settings.integrationConfigs[descriptor.id] ?? {};
      const enabled = settings.integrationEnabled[descriptor.id] ?? false;
      const secrets = await secretsStore.getSecrets(descriptor.id);

      // Merge saved non-secret config with any secret keys (masked).
      const maskedConfig: Record<string, unknown> = { ...savedConfig };
      for (const key of SECRET_KEYS[descriptor.id] ?? []) {
        maskedConfig[key] = secrets[key] ? "••••" : "";
      }

      this.states.set(descriptor.id, {
        id: descriptor.id,
        enabled,
        connection: "disconnected",
        message: null,
        config: maskedConfig,
      });
    }

    // Apply PCO credentials to stage controller if already configured.
    await this.applyPcoCredentials();

    // Initialize wireless connections manager (loads persisted connections,
    // connects enabled real-driver ones).
    await wirelessManager.init();
    // Reflect initial summary state in the master wireless IntegrationState.
    this.refreshWirelessSummary();

    console.log("[integration-manager] init complete", {
      integrations: Array.from(this.states.keys()),
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  getDescriptors(): IntegrationDescriptor[] {
    return DESCRIPTORS;
  }

  getStates(): IntegrationState[] {
    return Array.from(this.states.values());
  }

  async setConfig(
    id: string,
    config: Record<string, unknown>,
  ): Promise<IntegrationState> {
    console.log(`[integration-manager] setConfig ${id}`, Object.keys(config));
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown integration: ${id}`);

    const secretKeys = SECRET_KEYS[id] ?? [];
    const nonSecretConfig: Record<string, unknown> = {};
    const newSecrets: Record<string, string> = {};

    for (const [key, value] of Object.entries(config)) {
      if (secretKeys.includes(key)) {
        // Only update the secret if the caller provided a real value (not the mask).
        if (value !== "••••" && value !== "") {
          newSecrets[key] = String(value);
        }
      } else {
        nonSecretConfig[key] = value;
      }
    }

    // Persist non-secret config.
    const settings = await settingsStore.load();
    settings.integrationConfigs[id] = {
      ...(settings.integrationConfigs[id] ?? {}),
      ...nonSecretConfig,
    };
    await settingsStore.save(settings);

    // Persist secrets (merge with existing so unchanged ones survive).
    if (Object.keys(newSecrets).length > 0) {
      const existing = await secretsStore.getSecrets(id);
      await secretsStore.setSecrets(id, { ...existing, ...newSecrets });
    }

    // Rebuild masked config for state.
    const allSecrets = await secretsStore.getSecrets(id);
    const maskedConfig: Record<string, unknown> = {
      ...(settings.integrationConfigs[id] ?? {}),
    };
    for (const key of secretKeys) {
      maskedConfig[key] = allSecrets[key] ? "••••" : "";
    }

    this.states.set(id, { ...state, config: maskedConfig });

    // Side-effects for specific integrations.
    if (id === "planning-center") {
      await this.applyPcoCredentials();
      // Validate the credentials against PCO and load the lineup so the kiosk
      // updates immediately. A failure here reports an error status but never
      // fails the save (the credentials are already persisted).
      const appId = await this.getPcoAppId();
      const secret = await this.getPcoSecret();
      if (appId && secret) {
        try {
          const types = await stageController.listServiceTypes();
          this.setConnectionState(
            "planning-center",
            "connected",
            `Connected — ${types.length} service type(s)`,
          );
          await stageController.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.setConnectionState("planning-center", "error", msg);
        }
      }
    }

    this.broadcastStates();
    return this.states.get(id)!;
  }

  async setEnabled(id: string, enabled: boolean): Promise<IntegrationState> {
    console.log(`[integration-manager] setEnabled ${id} → ${enabled}`);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown integration: ${id}`);

    this.states.set(id, { ...state, enabled });

    const settings = await settingsStore.load();
    settings.integrationEnabled[id] = enabled;
    await settingsStore.save(settings);

    if (id === "wireless") {
      // Master toggle: re-apply connections without reloading from disk.
      await wirelessManager.reapply();
      this.refreshWirelessSummary();
    }

    if (id === "planning-center" && !enabled) {
      stageController.setPcoCredentials(null, null);
      this.setConnectionState("planning-center", "disconnected", null);
    }

    this.broadcastStates();
    return this.states.get(id)!;
  }

  async test(id: string): Promise<{ ok: boolean; message?: string }> {
    console.log(`[integration-manager] test ${id}`);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown integration: ${id}`);

    try {
      if (id === "planning-center") {
        const appId = await this.getPcoAppId();
        const secret = await this.getPcoSecret();
        if (!appId || !secret) {
          return { ok: false, message: "App ID and Secret are required" };
        }
        // Test by listing service types — minimal request.
        const { pcoService } = await import("./pco-service.js");
        const types = await pcoService.listServiceTypes(appId, secret);
        const msg = `Connected — found ${types.length} service type(s)`;
        this.setConnectionState("planning-center", "connected", msg);
        this.broadcastStates();
        return { ok: true, message: msg };
      }

      if (id === "wireless") {
        const connections = wirelessManager.listConnections();
        const connected = connections.filter((c) => c.connection === "connected").length;
        return {
          ok: true,
          message: `${connected} of ${connections.length} connection(s) connected`,
        };
      }

      if (id === "companion") {
        return { ok: true, message: "Companion endpoints available at /api/*" };
      }

      return { ok: false, message: `No test available for integration: ${id}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setConnectionState(id, "error", msg);
      this.broadcastStates();
      return { ok: false, message: msg };
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private setConnectionState(
    id: string,
    connection: IntegrationState["connection"],
    message: string | null,
  ): void {
    const state = this.states.get(id);
    if (state) {
      this.states.set(id, { ...state, connection, message });
    }
  }

  private async getPcoAppId(): Promise<string | null> {
    const settings = await settingsStore.load();
    return String(settings.integrationConfigs["planning-center"]?.appId ?? "") || null;
  }

  private async getPcoSecret(): Promise<string | null> {
    const secrets = await secretsStore.getSecrets("planning-center");
    return secrets.secret || null;
  }

  private async applyPcoCredentials(): Promise<void> {
    const appId = await this.getPcoAppId();
    const secret = await this.getPcoSecret();
    stageController.setPcoCredentials(appId, secret);

    if (appId && secret) {
      this.setConnectionState("planning-center", "connected", "Credentials configured");
    } else {
      this.setConnectionState("planning-center", "disconnected", null);
    }
  }

  /**
   * Refresh the master wireless IntegrationState to reflect an aggregated
   * summary of all connections managed by WirelessManager.
   */
  private refreshWirelessSummary(): void {
    const connections = wirelessManager.listConnections();
    const connected = connections.filter((c) => c.connection === "connected").length;
    if (connected > 0) {
      this.setConnectionState(
        "wireless",
        "connected",
        `${connected} of ${connections.length} connection(s) connected`,
      );
    } else {
      this.setConnectionState("wireless", "disconnected", null);
    }
  }

  private broadcastStates(): void {
    broadcast("integrations:state-changed", this.getStates());
  }
}

export const integrationManager = new IntegrationManager();
