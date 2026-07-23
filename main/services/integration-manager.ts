// IntegrationManager — registry for all integrations (PCO, Wireless, Companion).
// Holds descriptors + config + state; persist non-secret via settingsStore,
// secrets via secretsStore; broadcasts "integrations:state-changed".

import type { IntegrationDescriptor, IntegrationState } from "../types/integrations.js";
import type { PeopleCountDTO } from "../types/stage.js";
import { addBroadcastListener, broadcast } from "./broadcaster.js";
import { obsService } from "./obs-service.js";
import { reaperService } from "./reaper-service.js";
import { oscManager } from "./osc-manager.js";
import { prodcomService } from "./prodcom-service.js";
import { propresenterService, propresenterManager, type PropInstanceConfig } from "./propresenter-service.js";
import { secretsStore } from "./secrets.js";
import { type SenSourceConfig, sensourceService } from "./sensource-service.js";
import { settingsStore } from "./settings-store.js";
import { smaartService } from "./smaart-service.js";
import { stageController } from "./stage-controller.js";
import { type TslFeed, tslService } from "./tsl-service.js";
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
      help: "Create a Personal Access Token at api.planningcenteronline.com → Developers → Personal Access Tokens. The App ID and Secret are shown there.",
    },
    {
      key: "secret",
      label: "Secret",
      type: "password",
      placeholder: "your-secret",
      help: "The Secret half of your PCO Personal Access Token. Stored encrypted on this machine.",
    },
    {
      key: "refreshIntervalMin",
      label: "Refresh interval",
      type: "select",
      placeholder: "How often to pull the latest plan from PCO.",
      help: "How often Stage Utility re-syncs the plan, team roster, and photos from Planning Center. The live on-air countdown updates continuously regardless of this setting.",
      options: [
        { value: "5", label: "5 minutes" },
        { value: "15", label: "15 minutes" },
        { value: "30", label: "30 minutes" },
        { value: "60", label: "1 hour" },
        { value: "120", label: "2 hours" },
      ],
    },
    {
      key: "countdownTarget",
      label: "Pre-service countdown",
      type: "select",
      default: "plan-start",
      help: "What the countdown counts down to before a service is live. \"Plan start\" matches PCO's green timer (the top of the plan / doors) by counting to the service time minus any pre-service items above a \"service start\"-type header; if no such header exists it uses the service time. \"Service start time\" always counts to the PCO service time.",
      options: [
        { value: "plan-start", label: "Plan start (matches PCO)" },
        { value: "service-time", label: "Service start time" },
      ],
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

// Companion integration descriptor. There is nothing for the app to dial — the
// Bitfocus Companion module connects TO this app's HTTP/SSE API. So this carries
// no config; the settings panel (CompanionInfoPanel) shows the URL to point
// Companion at and a live connected-client count instead.
const COMPANION_DESCRIPTOR: IntegrationDescriptor = {
  id: "companion",
  kind: "control",
  label: "Bitfocus Companion",
  configSchema: [],
};

// ProPresenter integration — reads live slide/item status from the 7.9+ local
// HTTP API (LAN, no auth). Powers the dashboard display.
const PROPRESENTER_DESCRIPTOR: IntegrationDescriptor = {
  id: "propresenter",
  kind: "control",
  label: "ProPresenter",
  configSchema: [
    {
      key: "name",
      label: "Name",
      type: "text",
      placeholder: "Main (e.g. Auditorium 1)",
      help: "Display name for this ProPresenter, shown when a layout object picks which instance to read. Add more auditoriums below.",
    },
    {
      key: "host",
      label: "ProPresenter Host",
      type: "text",
      placeholder: "192.168.1.100",
      help: "IP or hostname of the machine running ProPresenter, on the same network as this server.",
    },
    {
      key: "port",
      label: "API Port",
      type: "number",
      placeholder: "1025",
      help: "ProPresenter's network API port. Turn the API on and find the port under ProPresenter → Preferences → Network (default 1025).",
    },
    {
      key: "pollMs",
      label: "Poll interval (ms)",
      type: "number",
      placeholder: "500 (lower = snappier, more requests)",
      help: "How often to query ProPresenter over the LAN. 500ms feels instant; raise it to ease network load. The API is under ProPresenter → Preferences → Network.",
    },
  ],
};

/** Parse the ProPresenter `config.instances` array (extra auditoriums) into typed
 *  configs, tolerating loosely-shaped stored JSON. */
function parsePropInstances(raw: unknown): PropInstanceConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: PropInstanceConfig[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) continue;
    const portNum =
      typeof o.port === "number" ? o.port : typeof o.port === "string" ? parseInt(o.port, 10) : NaN;
    const pollNum =
      typeof o.pollMs === "number" ? o.pollMs : typeof o.pollMs === "string" ? parseInt(o.pollMs, 10) : NaN;
    out.push({
      id: o.id,
      name: typeof o.name === "string" && o.name.trim() ? o.name : o.id,
      host: typeof o.host === "string" ? o.host.trim() : "",
      port: Number.isFinite(portNum) ? portNum : 0,
      pollMs: Number.isFinite(pollNum) ? pollNum : undefined,
      enabled: o.enabled !== false,
    });
  }
  return out;
}

// ProdCom integration — subscribes to the live transcription feed from ProdCom's
// HTTP Application API (default port 24480). Powers the transcription display.
const PRODCOM_DESCRIPTOR: IntegrationDescriptor = {
  id: "prodcom",
  kind: "lineup",
  label: "ProdCom",
  configSchema: [
    {
      key: "host",
      label: "ProdCom Host",
      type: "text",
      placeholder: "192.168.1.201",
      help: "IP or hostname of the machine running ProdCom, on the same network as this server.",
    },
    {
      key: "port",
      label: "API Port",
      type: "number",
      placeholder: "24480",
      help: "ProdCom's HTTP Application API port. Enable the Application API in ProdCom's settings (default 24480).",
    },
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "(only if Require Authentication is on)",
      help: "Only needed if ProdCom's API has 'Require Authentication' turned on — paste the key from ProdCom's API settings. Leave blank otherwise. Stored encrypted on this machine.",
    },
  ],
};

// Smaart integration — connects to Smaart's API (JSON-over-WebSocket, default
// port 26000) for live SPL meter values. Modern API (Smaart 8.3+) only.
const SMAART_DESCRIPTOR: IntegrationDescriptor = {
  id: "smaart",
  kind: "control",
  label: "Smaart (SPL)",
  configSchema: [
    {
      key: "host",
      label: "Smaart Host",
      type: "text",
      placeholder: "192.168.1.50",
      help: "IP or hostname of the machine running Smaart, on the same network. Requires Smaart 8.3+ (the modern JSON API).",
    },
    {
      key: "port",
      label: "API Port",
      type: "number",
      placeholder: "26000",
      help: "Smaart's API port. Enable the API in Smaart's API/IO settings (default 26000).",
    },
    {
      key: "password",
      label: "API Password",
      type: "password",
      placeholder: "(only if the Smaart API requires authentication)",
      help: "Only needed if Smaart's API is set to require authentication; otherwise leave blank. Stored encrypted on this machine.",
    },
  ],
};

// OBS Studio integration — connects to OBS's built-in obs-websocket v5 server
// (Tools → WebSocket Server Settings; default port 4455) for live output state
// (e.g. recording) shown by the custom-layout "OBS status" object.
const OBS_DESCRIPTOR: IntegrationDescriptor = {
  id: "obs",
  kind: "control",
  label: "OBS Studio",
  configSchema: [
    {
      key: "host",
      label: "OBS Host",
      type: "text",
      placeholder: "192.168.1.50",
      help: "IP or hostname of the machine running OBS, on the same network as this server.",
    },
    {
      key: "port",
      label: "WebSocket Port",
      type: "number",
      placeholder: "4455",
      help: "The obs-websocket server port. Enable the server under OBS → Tools → WebSocket Server Settings (default 4455).",
    },
    {
      key: "password",
      label: "Server Password",
      type: "password",
      placeholder: "(from OBS → Tools → WebSocket Server Settings)",
      help: "In OBS, open Tools → WebSocket Server Settings, enable the server, and copy the password here. Leave blank if you turned authentication off.",
    },
  ],
};

// REAPER integration — polls REAPER's built-in Web Interface (Preferences →
// Control/OSC/web → "Web browser interface") for live transport state (e.g.
// recording), shown by the custom-layout "REAPER status" object. No secret: the
// LAN web interface runs without auth in the common setup.
const REAPER_DESCRIPTOR: IntegrationDescriptor = {
  id: "reaper",
  kind: "control",
  label: "REAPER",
  configSchema: [
    {
      key: "host",
      label: "REAPER Host",
      type: "text",
      placeholder: "192.168.1.50",
      help: "IP or hostname of the machine running REAPER, on the same network as this server (the Access URL shown in REAPER's web interface settings).",
    },
    {
      key: "port",
      label: "Web Interface Port",
      type: "number",
      placeholder: "8080",
      help: "The port from REAPER → Preferences → Control/OSC/web → Web browser interface (\"Run web server on port\"). Leave the Username:password field blank there.",
    },
  ],
};

// OSC integration — sends OSC to LAN gear from custom-layout buttons and reflects
// device state back. Targets are managed as a separate list (like wireless), so
// the descriptor itself carries no config fields.
const OSC_DESCRIPTOR: IntegrationDescriptor = {
  id: "osc",
  kind: "control",
  label: "OSC",
  configSchema: [],
};

// SenSource Vea people-counter integration — polls the Vea API for live people
// counts (attendance / occupancy), shown by the custom-layout "People counter"
// object. The operator enters an API client id + secret (created in the Vea
// app); a directly-issued long-lived token can be pasted instead. Location/zone
// selection is handled by a dedicated picker (saved as non-secret config).
const SENSOURCE_DESCRIPTOR: IntegrationDescriptor = {
  id: "sensource",
  kind: "control",
  label: "SenSource Vea",
  configSchema: [
    {
      key: "clientId",
      label: "API Client ID",
      type: "text",
      placeholder: "(from Vea → API clients)",
      help: "Create an API client in the Vea web app (Settings → API clients). It gives you an ID + secret — enter both. Stage Utility handles the token exchange for you.",
    },
    {
      key: "clientSecret",
      label: "API Client Secret",
      type: "password",
      placeholder: "(from Vea → API clients)",
      help: "The Secret half of the Vea API client (created alongside the Client ID in Vea → API clients). Stored encrypted on this machine.",
    },
    {
      key: "apiToken",
      label: "Static token (optional)",
      type: "password",
      placeholder: "(only if your Vea account issues a long-lived token)",
      help: "Leave blank in the normal case — the client ID + secret above are all you need. Only fill this if your Vea account issues a long-lived token you'd rather use directly.",
    },
    {
      key: "pollSeconds",
      label: "Poll interval (s)",
      type: "number",
      placeholder: "45",
      default: 45,
      help: "How often to query SenSource. Their counts lag a few minutes server-side, so ~45s is plenty — lower values just add API calls without fresher data.",
    },
  ],
};

// Ross MultiViewer (TSL UMD) integration — pushes a people count to a Ross
// multiviewer tile as on-tile text via TSL UMD 3.1 over TCP. Which count drives
// which tile is configured as "feeds" (a custom panel), saved as non-secret
// config; the descriptor schema carries just the switcher host + TSL port.
const ROSS_TSL_DESCRIPTOR: IntegrationDescriptor = {
  id: "ross-tsl",
  kind: "control",
  label: "Ross MultiViewer (TSL UMD)",
  configSchema: [
    {
      key: "host",
      label: "Switcher Host",
      type: "text",
      placeholder: "192.168.1.60",
      help: "IP or hostname of the Ross multiviewer/switcher receiving the TSL UMD data, on the same network as this server.",
    },
    {
      key: "port",
      label: "TSL Port",
      type: "number",
      placeholder: "(TSL UMD input port on the Ross)",
      help: "The TSL UMD input port configured on the Ross device (its UMD/TSL setup). The people count is sent here as on-tile text; map a count to a tile's TSL address in the feeds panel below.",
    },
  ],
};

const DESCRIPTORS: IntegrationDescriptor[] = [
  PCO_DESCRIPTOR,
  WIRELESS_DESCRIPTOR,
  COMPANION_DESCRIPTOR,
  PROPRESENTER_DESCRIPTOR,
  PRODCOM_DESCRIPTOR,
  SMAART_DESCRIPTOR,
  OBS_DESCRIPTOR,
  REAPER_DESCRIPTOR,
  OSC_DESCRIPTOR,
  SENSOURCE_DESCRIPTOR,
  ROSS_TSL_DESCRIPTOR,
];

// Keys that are secrets for each integration id.
const SECRET_KEYS: Record<string, string[]> = {
  "planning-center": ["secret"],
  wireless: [],
  companion: [],
  propresenter: [],
  prodcom: ["apiKey"],
  smaart: ["password"],
  obs: ["password"],
  reaper: [],
  sensource: ["clientSecret", "apiToken"],
  "ross-tsl": [],
};

class IntegrationManager {
  private states = new Map<string, IntegrationState>();

  // ── Init ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    console.log("[integration-manager] init");
    propresenterManager.init();
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

    // Start auto-refresh with the persisted interval (defaults to 60 min).
    stageController.startAutoRefresh(this.getPcoRefreshIntervalMs());

    // Initialize wireless connections manager (loads persisted connections,
    // connects enabled real-driver ones).
    await wirelessManager.init();
    // Reflect initial summary state in the master wireless IntegrationState.
    this.refreshWirelessSummary();

    // Start the ProPresenter poller if it's enabled + configured.
    this.applyPropresenter();
    // Start the ProdCom transcript stream if enabled + configured.
    void this.applyProdcom();
    // Start the Smaart SPL connection if enabled + configured.
    await this.applySmaart();
    // Start the OBS connection if enabled + configured.
    await this.applyObs();
    // Start the REAPER web-interface poller if enabled + configured.
    await this.applyReaper();
    // Start the OSC manager (UDP send + feedback listener; per-target enable).
    await oscManager.init();
    this.refreshOscSummary();
    // Start the SenSource Vea poller if it's enabled + has credentials.
    await this.applySensource();
    // Forward live people counts to the Ross TSL sender (it ignores them when
    // disconnected), then start it if enabled + configured.
    addBroadcastListener((channel, payload) => {
      if (channel === "people:count") tslService.onPeopleCount(payload as PeopleCountDTO);
    });
    await this.applyRossTsl();

    console.log("[integration-manager] init complete", {
      integrations: Array.from(this.states.keys()),
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  getDescriptors(): IntegrationDescriptor[] {
    return DESCRIPTORS;
  }

  getStates(): IntegrationState[] {
    return Array.from(this.states.values()).map((s) => ({ ...s, configured: this.isConfigured(s) }));
  }

  /** Whether the operator has set an integration up — independent of the live
   *  connection, so the UI can tell "not configured" apart from "configured but
   *  currently disconnected". Cred-based integrations are configured once any
   *  config/secret value is saved; wireless/OSC (no config schema, set up via
   *  their own connection/target lists) use the master enable toggle. */
  private isConfigured(state: IntegrationState): boolean {
    if (state.id === "companion") return true; // inbound — nothing to set up
    if (state.id === "wireless" || state.id === "osc") return state.enabled;
    return Object.values(state.config).some((v) => v !== "" && v != null);
  }

  /** Live count of connected Companion-module clients (pushed from remote-server
   *  as SSE streams marked with the X-Companion-Module header connect/close). */
  private companionClients = 0;
  setCompanionClients(count: number): void {
    this.companionClients = count;
    this.setConnectionState(
      "companion",
      count > 0 ? "connected" : "disconnected",
      count > 0 ? `${count} Companion client(s) connected` : null,
    );
    this.broadcastStates();
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
      // Restart auto-refresh with the (possibly updated) interval.
      stageController.startAutoRefresh(this.getPcoRefreshIntervalMs());
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

    if (id === "propresenter") {
      this.applyPropresenter();
    }

    if (id === "prodcom") {
      await this.applyProdcom();
    }

    if (id === "smaart") {
      await this.applySmaart();
    }

    if (id === "obs") {
      await this.applyObs();
    }

    if (id === "reaper") {
      await this.applyReaper();
    }

    if (id === "sensource") {
      await this.applySensource();
    }

    if (id === "ross-tsl") {
      await this.applyRossTsl();
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

    if (id === "propresenter") {
      this.applyPropresenter();
    }

    if (id === "prodcom") {
      await this.applyProdcom();
    }

    if (id === "smaart") {
      await this.applySmaart();
    }

    if (id === "obs") {
      await this.applyObs();
    }

    if (id === "reaper") {
      await this.applyReaper();
    }

    if (id === "sensource") {
      await this.applySensource();
    }

    if (id === "ross-tsl") {
      await this.applyRossTsl();
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
        const n = this.companionClients;
        // Companion can't resolve DNS — report the raw LAN IP URL.
        const url = stageController.getState().lanUrl ?? stageController.getState().remoteUrl;
        const msg =
          n > 0
            ? `${n} Companion client(s) connected`
            : `Ready — point Companion at ${url ?? "this server's LAN address"}`;
        this.setConnectionState("companion", n > 0 ? "connected" : "disconnected", msg);
        this.broadcastStates();
        return { ok: true, message: msg };
      }

      if (id === "propresenter") {
        const { host, port } = this.getPropresenterTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const result = await propresenterService.test(host, port);
        this.setConnectionState(
          "propresenter",
          result.ok ? "connected" : "error",
          result.message ?? null,
        );
        this.broadcastStates();
        return result;
      }

      if (id === "prodcom") {
        const { host, port } = this.getProdcomTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const secrets = await secretsStore.getSecrets("prodcom");
        const result = await prodcomService.test(host, port, secrets.apiKey ?? null);
        this.setConnectionState("prodcom", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "smaart") {
        const { host, port } = this.getSmaartTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const secrets = await secretsStore.getSecrets("smaart");
        const result = await smaartService.test(host, port, secrets.password ?? null);
        this.setConnectionState("smaart", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "obs") {
        const { host, port } = this.getObsTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const secrets = await secretsStore.getSecrets("obs");
        const result = await obsService.test(host, port, secrets.password ?? null);
        this.setConnectionState("obs", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "reaper") {
        const { host, port } = this.getReaperTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const result = await reaperService.test(host, port);
        this.setConnectionState("reaper", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "sensource") {
        const cfg = await this.getSensourceConfig();
        if (!cfg.apiToken && (!cfg.clientId || !cfg.clientSecret)) {
          return { ok: false, message: "Client ID and Secret (or a static token) are required" };
        }
        const result = await sensourceService.test(cfg);
        this.setConnectionState("sensource", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "ross-tsl") {
        const { host, port } = this.getRossTslConfig();
        if (!host || !port) {
          return { ok: false, message: "Switcher Host and TSL Port are required" };
        }
        const result = await tslService.test(host, port);
        this.setConnectionState("ross-tsl", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
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

  private getPcoRefreshIntervalMs(): number {
    const state = this.states.get("planning-center");
    const raw = state?.config["refreshIntervalMin"];
    const min = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
    return Number.isFinite(min) && min > 0 ? min * 60 * 1000 : 60 * 60 * 1000;
  }

  private getPropresenterTarget(): { host: string | null; port: number | null; pollMs: number | null } {
    const cfg = this.states.get("propresenter")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    const rawPoll = cfg.pollMs;
    const pollMs =
      typeof rawPoll === "number"
        ? rawPoll
        : typeof rawPoll === "string" && rawPoll.trim()
          ? parseInt(rawPoll, 10)
          : NaN;
    return {
      host,
      port: Number.isFinite(port) && port > 0 ? port : null,
      pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : null,
    };
  }

  /** Start/stop the ProPresenter poller to match enabled + configured state. */
  private applyPropresenter(): void {
    // Reflect live reachability on the Integrations card badge. Idempotent —
    // setting the same listener again just overwrites it.
    propresenterService.setConnectionListener((state, message) => {
      this.setConnectionState("propresenter", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("propresenter")?.enabled ?? false;
    const { host, port, pollMs } = this.getPropresenterTarget();
    if (enabled && host && port) {
      // configure() starts polling; the listener flips this to connected/error
      // on the first tick.
      this.setConnectionState("propresenter", "connecting", `Polling ${host}:${port}`);
      propresenterService.configure(host, port, pollMs ?? undefined);
    } else {
      propresenterService.stop();
      this.setConnectionState("propresenter", "disconnected", null);
    }

    // Extra ProPresenter instances (additional auditoriums) — only while enabled.
    const cfg = this.states.get("propresenter")?.config ?? {};
    const defaultName = typeof cfg.name === "string" ? cfg.name : null;
    propresenterManager.apply(defaultName, enabled ? parsePropInstances(cfg.instances) : []);
  }

  private getProdcomTarget(): { host: string | null; port: number | null } {
    const cfg = this.states.get("prodcom")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    return { host, port: Number.isFinite(port) && port > 0 ? port : null };
  }

  /** Start/stop the ProdCom transcript stream to match enabled + configured state. */
  private async applyProdcom(): Promise<void> {
    prodcomService.setConnectionListener((state, message) => {
      this.setConnectionState("prodcom", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("prodcom")?.enabled ?? false;
    const { host, port } = this.getProdcomTarget();
    if (enabled && host && port) {
      const secrets = await secretsStore.getSecrets("prodcom");
      this.setConnectionState("prodcom", "connecting", `Connecting ${host}:${port}`);
      prodcomService.configure(host, port, secrets.apiKey ?? null);
    } else {
      prodcomService.stop();
      this.setConnectionState("prodcom", "disconnected", null);
    }
  }

  private getSmaartTarget(): { host: string | null; port: number | null } {
    const cfg = this.states.get("smaart")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    // Default to Smaart's standard API port when only a host is given.
    return { host, port: Number.isFinite(port) && port > 0 ? port : host ? 26000 : null };
  }

  /** Start/stop the Smaart SPL connection to match enabled + configured state. */
  private async applySmaart(): Promise<void> {
    smaartService.setConnectionListener((state, message) => {
      this.setConnectionState("smaart", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("smaart")?.enabled ?? false;
    const { host, port } = this.getSmaartTarget();
    if (enabled && host && port) {
      const secrets = await secretsStore.getSecrets("smaart");
      this.setConnectionState("smaart", "connecting", `Connecting ${host}:${port}`);
      smaartService.configure(host, port, secrets.password ?? null);
    } else {
      smaartService.stop();
      this.setConnectionState("smaart", "disconnected", null);
    }
  }

  private getObsTarget(): { host: string | null; port: number | null } {
    const cfg = this.states.get("obs")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    // Default to obs-websocket's standard port when only a host is given.
    return { host, port: Number.isFinite(port) && port > 0 ? port : host ? 4455 : null };
  }

  private getReaperTarget(): { host: string | null; port: number | null } {
    const cfg = this.states.get("reaper")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    // Default to REAPER's suggested web-interface port when only a host is given.
    return { host, port: Number.isFinite(port) && port > 0 ? port : host ? 8080 : null };
  }

  /** Start/stop the REAPER web-interface poll to match enabled + configured state. */
  private async applyReaper(): Promise<void> {
    reaperService.setConnectionListener((state, message) => {
      this.setConnectionState("reaper", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("reaper")?.enabled ?? false;
    const { host, port } = this.getReaperTarget();
    if (enabled && host && port) {
      this.setConnectionState("reaper", "connecting", `Connecting ${host}:${port}`);
      reaperService.configure(host, port);
    } else {
      reaperService.stop();
      this.setConnectionState("reaper", "disconnected", null);
    }
  }

  /** Start/stop the OBS connection to match enabled + configured state. */
  private async applyObs(): Promise<void> {
    obsService.setConnectionListener((state, message) => {
      this.setConnectionState("obs", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("obs")?.enabled ?? false;
    const { host, port } = this.getObsTarget();
    if (enabled && host && port) {
      const secrets = await secretsStore.getSecrets("obs");
      this.setConnectionState("obs", "connecting", `Connecting ${host}:${port}`);
      obsService.configure(host, port, secrets.password ?? null);
    } else {
      obsService.stop();
      this.setConnectionState("obs", "disconnected", null);
    }
  }

  /** Resolve the SenSource config from non-secret state + the secrets store. */
  private async getSensourceConfig(): Promise<SenSourceConfig> {
    const cfg = this.states.get("sensource")?.config ?? {};
    const secrets = await secretsStore.getSecrets("sensource");
    const rawPoll = cfg.pollSeconds;
    const pollSeconds =
      typeof rawPoll === "number"
        ? rawPoll
        : typeof rawPoll === "string" && rawPoll.trim()
          ? parseInt(rawPoll, 10)
          : NaN;
    return {
      clientId: typeof cfg.clientId === "string" && cfg.clientId.trim() ? cfg.clientId.trim() : null,
      clientSecret: secrets.clientSecret || null,
      apiToken: secrets.apiToken || null,
      pollSeconds: Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds : 45,
      locationId:
        typeof cfg.locationId === "string" && cfg.locationId.trim() ? cfg.locationId.trim() : null,
      zoneIds: Array.isArray(cfg.zoneIds) ? cfg.zoneIds.filter((z): z is string => typeof z === "string") : [],
    };
  }

  /** List Vea locations for the settings picker (uses the saved credentials). */
  async getSensourceLocations(): Promise<{ locationId: string; name: string }[]> {
    const cfg = await this.getSensourceConfig();
    if (!cfg.apiToken && (!cfg.clientId || !cfg.clientSecret)) {
      throw new Error("Enter and save SenSource credentials first");
    }
    return sensourceService.listLocationsWith(cfg);
  }

  /** List Vea zones for the settings picker — the reliable scoping mechanism
   *  (the API has no working server-side location/zone filter). */
  async getSensourceZones(): Promise<{ zoneId: string; name: string; locationId: string | null }[]> {
    const cfg = await this.getSensourceConfig();
    if (!cfg.apiToken && (!cfg.clientId || !cfg.clientSecret)) {
      throw new Error("Enter and save SenSource credentials first");
    }
    return sensourceService.listZonesWith(cfg);
  }

  /** Start/stop the SenSource poller to match enabled + credentialed state. */
  private async applySensource(): Promise<void> {
    sensourceService.setConnectionListener((state, message) => {
      this.setConnectionState("sensource", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("sensource")?.enabled ?? false;
    const cfg = await this.getSensourceConfig();
    const hasCreds = !!cfg.apiToken || (!!cfg.clientId && !!cfg.clientSecret);
    if (enabled && hasCreds) {
      this.setConnectionState("sensource", "connecting", "Authenticating with SenSource Vea");
      sensourceService.configure(cfg);
    } else {
      sensourceService.stop();
      this.setConnectionState("sensource", "disconnected", null);
    }
  }

  /** Resolve the Ross TSL config (host/port + the feed→display-index mappings). */
  private getRossTslConfig(): { host: string | null; port: number | null; feeds: TslFeed[] } {
    const cfg = this.states.get("ross-tsl")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    const feeds = Array.isArray(cfg.feeds) ? (cfg.feeds as TslFeed[]) : [];
    return { host, port: Number.isFinite(port) && port > 0 ? port : null, feeds };
  }

  /** Start/stop the Ross TSL sender to match enabled + configured state. */
  private async applyRossTsl(): Promise<void> {
    tslService.setConnectionListener((state, message) => {
      this.setConnectionState("ross-tsl", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("ross-tsl")?.enabled ?? false;
    const { host, port, feeds } = this.getRossTslConfig();
    if (enabled && host && port) {
      this.setConnectionState("ross-tsl", "connecting", `Connecting ${host}:${port}`);
      tslService.configure(host, port, feeds);
    } else {
      tslService.stop();
      this.setConnectionState("ross-tsl", "disconnected", null);
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
    const settings = await settingsStore.load();
    const target = settings.integrationConfigs["planning-center"]?.countdownTarget === "service-time" ? "service-time" : "plan-start";
    stageController.setPcoCredentials(appId, secret, target);

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

  /** Reflect an aggregated summary of OSC targets on the master "osc" state. */
  refreshOscSummary(): void {
    const targets = oscManager.listTargets();
    const enabled = targets.filter((t) => t.enabled).length;
    if (enabled > 0) {
      this.setConnectionState("osc", "connected", `${enabled} target(s) active`);
    } else {
      this.setConnectionState("osc", "disconnected", targets.length ? `${targets.length} target(s)` : null);
    }
  }

  private broadcastStates(): void {
    broadcast("integrations:state-changed", this.getStates());
  }
}

export const integrationManager = new IntegrationManager();
