
import { createRequire as __createRequire__ } from 'module';
const require = __createRequire__(import.meta.url);

var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// main/services/pco-service.ts
var pco_service_exports = {};
__export(pco_service_exports, {
  pcoService: () => pcoService
});
var PCO_BASE, CACHE_TTL_MS, PcoService, pcoService;
var init_pco_service = __esm({
  "main/services/pco-service.ts"() {
    "use strict";
    PCO_BASE = "https://api.planningcenteronline.com/services/v2";
    CACHE_TTL_MS = 3e4;
    PcoService = class {
      cache = /* @__PURE__ */ new Map();
      cacheGet(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
          this.cache.delete(key);
          return null;
        }
        return entry.value;
      }
      cacheSet(key, value) {
        if (this.cache.size >= 200) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey !== void 0) this.cache.delete(firstKey);
        }
        this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      clearCache() {
        this.cache.clear();
      }
      makeAuthHeader(appId, secret) {
        const creds = Buffer.from(`${appId}:${secret}`).toString("base64");
        return `Basic ${creds}`;
      }
      async request(url, appId, secret) {
        console.log(`[pco] GET ${url}`);
        const response = await fetch(url, {
          headers: {
            Authorization: this.makeAuthHeader(appId, secret),
            "Content-Type": "application/json"
          }
        });
        if (response.status === 401) {
          throw new Error("PCO auth failed \u2014 check App ID/Secret in Integrations settings");
        }
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`PCO API error ${response.status}: ${body || response.statusText}`);
        }
        const json2 = await response.json();
        console.log(`[pco] OK ${url} (${Array.isArray(json2.data) ? json2.data.length : 1} items)`);
        return json2;
      }
      async listServiceTypes(appId, secret) {
        const cacheKey = `service-types:${appId}`;
        const cached = this.cacheGet(cacheKey);
        if (cached) return cached;
        const url = `${PCO_BASE}/service_types?per_page=100`;
        const json2 = await this.request(url, appId, secret);
        const items = Array.isArray(json2.data) ? json2.data : [json2.data];
        const result = items.map((item) => ({
          id: item.id,
          name: String(item.attributes.name ?? "Unknown")
        }));
        this.cacheSet(cacheKey, result);
        return result;
      }
      async listUpcomingPlans(appId, secret, serviceTypeId) {
        const cacheKey = `plans:${appId}:${serviceTypeId}`;
        const cached = this.cacheGet(cacheKey);
        if (cached) return cached;
        const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans?filter=future&order=sort_date&per_page=25`;
        const json2 = await this.request(url, appId, secret);
        const items = Array.isArray(json2.data) ? json2.data : [json2.data];
        const result = items.map((item) => ({
          id: item.id,
          title: String(item.attributes.title ?? item.attributes.series_title ?? item.attributes.dates ?? "Untitled"),
          seriesTitle: item.attributes.series_title != null && String(item.attributes.series_title) !== "" ? String(item.attributes.series_title) : null,
          sortDate: item.attributes.sort_date != null ? String(item.attributes.sort_date) : null,
          dates: item.attributes.dates != null ? String(item.attributes.dates) : null
        }));
        this.cacheSet(cacheKey, result);
        return result;
      }
      async listTeamMembers(appId, secret, serviceTypeId, planId) {
        const cacheKey = `team:${appId}:${serviceTypeId}:${planId}`;
        const cached = this.cacheGet(cacheKey);
        if (cached) return cached;
        const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/team_members?include=person,team&per_page=100`;
        const json2 = await this.request(url, appId, secret);
        const items = Array.isArray(json2.data) ? json2.data : [json2.data];
        const includedById = /* @__PURE__ */ new Map();
        for (const node of json2.included ?? []) {
          includedById.set(`${node.id}`, node);
        }
        const result = items.map((item) => {
          const personRel = item.relationships?.person?.data;
          const teamRel = item.relationships?.team?.data;
          let personId = null;
          let photoUrl = null;
          let teamName = null;
          if (personRel && !Array.isArray(personRel)) {
            personId = personRel.id;
            const personNode = includedById.get(personRel.id);
            if (personNode) {
              const attrs = personNode.attributes;
              photoUrl = attrs.photo_thumbnail_url != null && String(attrs.photo_thumbnail_url) || attrs.photo_url != null && String(attrs.photo_url) || attrs.avatar != null && String(attrs.avatar) || attrs.photo_thumbnail != null && String(attrs.photo_thumbnail) || null;
            }
            if (!photoUrl) {
              const a = item.attributes;
              photoUrl = a.photo_thumbnail_url != null && String(a.photo_thumbnail_url) || a.photo_url != null && String(a.photo_url) || a.avatar != null && String(a.avatar) || a.photo_thumbnail != null && String(a.photo_thumbnail) || null;
            }
          }
          if (teamRel && !Array.isArray(teamRel)) {
            const teamNode = includedById.get(teamRel.id);
            if (teamNode) {
              teamName = teamNode.attributes.name != null ? String(teamNode.attributes.name) : null;
            }
          }
          return {
            id: item.id,
            name: String(item.attributes.name ?? "Unknown"),
            personId,
            photoUrl,
            teamPositionName: item.attributes.team_position_name != null ? String(item.attributes.team_position_name) : null,
            teamName,
            status: String(item.attributes.status ?? "U")
          };
        });
        this.cacheSet(cacheKey, result);
        return result;
      }
    };
    pcoService = new PcoService();
  }
});

// main/windows/window-paths.ts
import * as fs3 from "fs";
import * as path3 from "path";
import { fileURLToPath, pathToFileURL } from "url";
function resolveWindowHtml(htmlFileName) {
  return path3.join(BUILD_ROOT, htmlFileName);
}
function getWindowFileUrl(htmlFileName) {
  return pathToFileURL(resolveWindowHtml(htmlFileName)).toString();
}
function getPreloadPath() {
  return path3.join(BUILD_ROOT, "assets", "preload.js");
}
async function getWindowUrl(htmlFileName) {
  const devServerHostFile = path3.join(BUILD_ROOT, "..", ".devserverhost");
  if (fs3.existsSync(devServerHostFile)) {
    try {
      const devServerHost = (await fs3.promises.readFile(devServerHostFile, "utf-8")).trim();
      if (devServerHost) {
        return `${devServerHost}/${htmlFileName}`;
      }
    } catch {
    }
  }
  return getWindowFileUrl(htmlFileName);
}
var currentFilePath, currentDirPath, BUILD_ROOT;
var init_window_paths = __esm({
  "main/windows/window-paths.ts"() {
    "use strict";
    currentFilePath = fileURLToPath(import.meta.url);
    currentDirPath = path3.dirname(currentFilePath);
    BUILD_ROOT = path3.resolve(currentDirPath, "..");
  }
});

// main/windows/display-windows.ts
var display_windows_exports = {};
__export(display_windows_exports, {
  closeAllDisplayWindows: () => closeAllDisplayWindows,
  closeDisplayWindow: () => closeDisplayWindow,
  getDisplayWindow: () => getDisplayWindow,
  openDisplayWindow: () => openDisplayWindow
});
import { BrowserWindow, logger as logger2 } from "@glaze/core/backend";
async function openDisplayWindow(display) {
  const existing = displayWindows.get(display.id);
  if (existing && !existing.isDestroyed()) {
    logger2.debug("display-windows", `Focusing existing window for display ${display.id}`);
    existing.show();
    existing.focus();
    return existing;
  }
  logger2.info("display-windows", `Creating window for display ${display.id} ("${display.name}")`);
  const win = new BrowserWindow({
    windowKey: `display-${display.id}`,
    width: 1e3,
    height: 700,
    minWidth: 390,
    minHeight: 456,
    title: `Stage Monitor \u2014 ${display.name}`,
    show: false,
    webPreferences: {
      preload: getPreloadPath()
    }
  });
  win.once("ready-to-show", () => {
    win.show();
  });
  win.on("closed", () => {
    displayWindows.delete(display.id);
    logger2.debug("display-windows", `Window closed for display ${display.id}`);
  });
  const baseUrl = await getWindowUrl("main-window.html");
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}display=${encodeURIComponent(display.id)}`;
  logger2.info("display-windows", `Loading URL for display ${display.id}`, { url });
  await win.loadURL(url);
  displayWindows.set(display.id, win);
  return win;
}
function closeDisplayWindow(displayId) {
  const win = displayWindows.get(displayId);
  if (win && !win.isDestroyed()) {
    logger2.info("display-windows", `Closing window for display ${displayId}`);
    win.close();
  }
  displayWindows.delete(displayId);
}
function closeAllDisplayWindows() {
  logger2.info("display-windows", `Closing all ${displayWindows.size} display window(s)`);
  for (const [id, win] of displayWindows.entries()) {
    if (!win.isDestroyed()) {
      win.close();
    }
    displayWindows.delete(id);
  }
}
function getDisplayWindow(displayId) {
  const win = displayWindows.get(displayId);
  return win && !win.isDestroyed() ? win : null;
}
var displayWindows;
var init_display_windows = __esm({
  "main/windows/display-windows.ts"() {
    "use strict";
    init_window_paths();
    displayWindows = /* @__PURE__ */ new Map();
  }
});

// main/index.ts
import { app as app4, Menu, logger as logger5, initDevToolsButtonState, protocol } from "@glaze/core/backend";

// main/handlers/index.ts
import * as path5 from "path";
import { fileURLToPath as fileURLToPath3 } from "url";

// main/handlers/app.ts
import { logger } from "@glaze/core/backend";
var appHandlers = {
  // Example: Get app information
  getInfo: async () => {
    logger.info("app", "App info requested");
    return {
      name: "My Glaze App",
      version: "1.0.0",
      environment: process.env.NODE_ENV || "production"
    };
  }
  // TODO: Add your app handlers here
  // Example:
  // myMethod: async (params: { arg1: string }) => {
  //   return { result: 'success' };
  // }
};

// main/handlers/integrations.ts
import { ipcMain as ipcMain4 } from "@glaze/core/backend";

// main/providers/wireless/none-provider.ts
var NoneProvider = class {
  id = "none";
  label = "None";
  configSchema = [];
  async connect(_cfg) {
  }
  async disconnect() {
  }
  async listChannels() {
    return [];
  }
  onStatus(_cb) {
  }
  getConnectionState() {
    return "disconnected";
  }
};

// main/providers/wireless/shure-base.ts
import * as net from "net";
var RECONNECT_DELAY_MS = 3e3;
var HEARTBEAT_INTERVAL_MS = 3e4;
var ShureBaseProvider = class {
  socket = null;
  receiveBuffer = "";
  connectionState = "disconnected";
  statusCallback = null;
  reconnectTimer = null;
  heartbeatTimer = null;
  enabled = false;
  cfg = { host: "", port: 2202, channels: 1, meterRateMs: 1e3 };
  /** Metering interval (ms) for this connection — set from config on connect. */
  get meterRateMs() {
    return this.cfg.meterRateMs;
  }
  // Per-channel state, keyed by channel number (1-based).
  channelStates = /* @__PURE__ */ new Map();
  // ── DeviceProvider interface ──────────────────────────────────────────────
  onStatus(cb) {
    this.statusCallback = cb;
  }
  getConnectionState() {
    return this.connectionState;
  }
  async connect(cfg) {
    this.enabled = true;
    this.cfg = this.parseCfg(cfg);
    this.initChannelStates(this.cfg.channels);
    await this.openSocket();
  }
  async disconnect() {
    this.enabled = false;
    this.clearTimers();
    this.destroySocket();
    this.setConnectionState("disconnected");
    this.markAllChannelsOffline();
  }
  async listChannels() {
    const result = [];
    for (let n = 1; n <= this.cfg.channels; n++) {
      const state = this.channelStates.get(n);
      result.push({
        id: String(n),
        label: state?.name ?? `Ch ${n}`
      });
    }
    return result;
  }
  // ── Protected helpers ─────────────────────────────────────────────────────
  /** Send a command over the TCP socket. cmd must NOT include the `< >` framing. */
  send(cmd) {
    if (!this.socket || this.connectionState !== "connected") return;
    const raw = `< ${cmd} >
`;
    try {
      this.socket.write(raw);
    } catch (err) {
      console.error(`[shure:${this.id}] send error:`, err);
    }
  }
  /** Initialise (or reset) channel states to their offline defaults. */
  initChannelStates(count) {
    this.channelStates.clear();
    for (let n = 1; n <= count; n++) {
      this.channelStates.set(n, {
        channelId: String(n),
        name: null,
        deviceType: this.defaultDeviceType,
        online: false,
        rfBars: null,
        rfLevelDbm: null,
        battery: null,
        charging: null,
        frequencyLabel: null,
        audioLevel: null
      });
    }
  }
  /** Emit a DeviceStatus for the given channel. */
  emitStatus(channelNumber) {
    const state = this.channelStates.get(channelNumber);
    if (!state || !this.statusCallback) return;
    const status = {
      channelId: state.channelId,
      name: state.name,
      deviceType: state.deviceType,
      online: state.online,
      rfBars: state.rfBars,
      rfLevelDbm: state.rfLevelDbm,
      battery: state.battery,
      charging: state.charging,
      frequencyLabel: state.frequencyLabel,
      audioLevel: state.audioLevel,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.statusCallback(status);
  }
  /** Emit offline status for all channels. */
  markAllChannelsOffline() {
    for (const [n, state] of this.channelStates) {
      state.online = false;
      this.emitStatus(n);
    }
  }
  // ── Private networking ────────────────────────────────────────────────────
  parseCfg(raw) {
    const host = typeof raw.host === "string" ? raw.host.trim() : "";
    const port = typeof raw.port === "number" && raw.port > 0 ? Math.floor(raw.port) : 2202;
    const channels = typeof raw.channels === "number" && raw.channels > 0 ? Math.floor(raw.channels) : this.defaultChannels;
    const meterRateMs = typeof raw.meterRateMs === "number" && raw.meterRateMs >= 0 ? Math.floor(raw.meterRateMs) : 1e3;
    return { host, port, channels, meterRateMs };
  }
  setConnectionState(state) {
    this.connectionState = state;
  }
  async openSocket() {
    if (!this.cfg.host) {
      console.error(`[shure:${this.id}] no host configured`);
      this.setConnectionState("error");
      return;
    }
    this.setConnectionState("connecting");
    console.log(`[shure:${this.id}] connecting to ${this.cfg.host}:${this.cfg.port}`);
    const socket = new net.Socket();
    this.socket = socket;
    this.receiveBuffer = "";
    socket.setEncoding("utf8");
    socket.setKeepAlive(true, 1e4);
    socket.setTimeout(15e3);
    socket.on("connect", () => {
      console.log(`[shure:${this.id}] connected to ${this.cfg.host}:${this.cfg.port}`);
      socket.setTimeout(0);
      this.setConnectionState("connected");
      this.startHeartbeat();
      this.onConnected();
    });
    socket.on("data", (chunk) => {
      this.handleData(chunk);
    });
    socket.on("timeout", () => {
      console.warn(`[shure:${this.id}] socket timeout`);
      socket.destroy();
    });
    socket.on("error", (err) => {
      console.error(`[shure:${this.id}] socket error:`, err.message);
      this.setConnectionState("error");
    });
    socket.on("close", () => {
      console.log(`[shure:${this.id}] socket closed`);
      this.stopHeartbeat();
      this.markAllChannelsOffline();
      if (this.connectionState !== "disconnected") {
        this.setConnectionState("disconnected");
      }
      if (this.enabled) {
        this.scheduleReconnect();
      }
    });
    socket.connect(this.cfg.port, this.cfg.host);
  }
  handleData(chunk) {
    this.receiveBuffer += chunk;
    const segments = this.receiveBuffer.split(">");
    this.receiveBuffer = segments.pop() ?? "";
    for (const segment of segments) {
      const cleaned = segment.replace(/^[\s<]+/, "").trim();
      if (!cleaned) continue;
      this.parseMessage(cleaned);
    }
  }
  parseMessage(raw) {
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    const type = tokens[0].toUpperCase();
    if (type === "SAMPLE") {
      const ch = parseInt(tokens[1] ?? "", 10);
      if (Number.isNaN(ch) || ch < 1) {
        console.debug(`[shure:${this.id}] SAMPLE \u2014 unrecognised channel token: ${tokens[1]}`);
        return;
      }
      if (!this.channelStates.has(ch)) {
        console.debug(`[shure:${this.id}] SAMPLE ch ${ch} outside configured range`);
        return;
      }
      this.handleSample(ch, tokens);
      return;
    }
    if (type === "REP" || type === "REPORT") {
      if (tokens.length < 3) {
        console.debug(`[shure:${this.id}] short REP message: ${raw}`);
        return;
      }
      const secondToken = tokens[1];
      const chNum = parseInt(secondToken, 10);
      if (!Number.isNaN(chNum)) {
        if (!this.channelStates.has(chNum)) {
          console.debug(`[shure:${this.id}] REP ch ${chNum} outside configured range`);
          return;
        }
        const field = tokens[2].toUpperCase();
        const rest = tokens.slice(3);
        this.handleReport(chNum, field, rest);
      } else {
        const field = tokens[1].toUpperCase();
        const rest = tokens.slice(2);
        this.handleReport(0, field, rest);
      }
      return;
    }
    console.debug(`[shure:${this.id}] unrecognised message type: ${type}`);
  }
  scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    console.log(`[shure:${this.id}] will reconnect in ${RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled) {
        this.initChannelStates(this.cfg.channels);
        void this.openSocket();
      }
    }, RECONNECT_DELAY_MS);
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send("GET 1 METER_RATE");
    }, HEARTBEAT_INTERVAL_MS);
  }
  stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  clearTimers() {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  destroySocket() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.receiveBuffer = "";
  }
};
function safeInt(s) {
  if (s === void 0) return NaN;
  const n = parseInt(s, 10);
  return n;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function normalisedDb(db, minDb, maxDb) {
  if (maxDb <= minDb) return 0;
  return clamp((db - minDb) / (maxDb - minDb), 0, 1);
}
function rfBarsFromDbm(dbm) {
  if (dbm >= -25) return 5;
  if (dbm >= -70) return 4;
  if (dbm >= -77) return 3;
  if (dbm >= -83) return 2;
  if (dbm >= -90) return 1;
  return 0;
}
function stripBraces(s) {
  return s.replace(/^\{/, "").replace(/\}$/, "").trim();
}
function formatFrequency(raw) {
  if (raw.length !== 6) return null;
  return `${raw.slice(0, 3)}.${raw.slice(3)} MHz`;
}

// main/providers/wireless/shure-axient.ts
var ShureAxient = class extends ShureBaseProvider {
  id = "shure-axient";
  label = "Shure Axient Digital";
  configSchema = [
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.100"
    },
    {
      key: "port",
      label: "TCP Port",
      type: "number",
      placeholder: "2202"
    },
    {
      key: "channels",
      label: "Number of Channels",
      type: "number",
      placeholder: "4"
    }
  ];
  defaultChannels = 4;
  defaultDeviceType = "receiver";
  // ── Init commands ─────────────────────────────────────────────────────────
  onConnected() {
    console.log(`[shure:${this.id}] sending init commands`);
    this.send("GET 0 ALL");
    this.send(`SET 0 METER_RATE ${this.meterRateMs}`);
  }
  // ── REP / REPORT messages ─────────────────────────────────────────────────
  handleReport(channel, token, rest) {
    if (channel === 0) {
      console.debug(`[shure:${this.id}] device-level REP: ${token} ${rest.join(" ")}`);
      return;
    }
    if (token === "SLOT") {
      console.debug(`[shure:${this.id}] ch${channel} SLOT report skipped (v1)`);
      return;
    }
    const state = this.channelStates.get(channel);
    if (!state) return;
    const value = rest.join(" ");
    switch (token) {
      case "CHAN_NAME": {
        state.name = stripBraces(value).slice(0, 31) || null;
        console.log(`[shure:${this.id}] ch${channel} name: ${state.name ?? "(none)"}`);
        break;
      }
      case "BATT_BARS": {
        const bars = safeInt(value);
        if (!Number.isNaN(bars)) {
          if (bars === 255) {
            state.battery = null;
            state.online = false;
          } else {
            if (state.battery === null) state.battery = bars * 20;
            state.online = true;
          }
        }
        console.debug(`[shure:${this.id}] ch${channel} BATT_BARS: ${value}`);
        break;
      }
      case "BATT_CHARGE": {
        const charge = safeInt(value);
        if (!Number.isNaN(charge)) {
          state.battery = charge === 255 ? null : clamp(charge, 0, 100);
        }
        console.debug(`[shure:${this.id}] ch${channel} BATT_CHARGE: ${value}`);
        break;
      }
      case "BATT_RUN_TIME": {
        const minutes = safeInt(value);
        if (!Number.isNaN(minutes) && minutes < 65533) {
          console.debug(`[shure:${this.id}] ch${channel} battery runtime: ${minutes} min`);
        } else {
          console.debug(`[shure:${this.id}] ch${channel} battery runtime: unknown/calculating`);
        }
        break;
      }
      case "FREQUENCY": {
        state.frequencyLabel = formatFrequency(value);
        console.debug(`[shure:${this.id}] ch${channel} freq: ${state.frequencyLabel ?? value}`);
        break;
      }
      case "MUTE_MODE_STATUS": {
        console.debug(`[shure:${this.id}] ch${channel} MUTE_MODE_STATUS: ${value}`);
        break;
      }
      case "TX_TYPE":
      case "TX_MODEL": {
        if (value === "UNKNOWN" || value === "UNKN") {
          state.online = false;
          console.log(`[shure:${this.id}] ch${channel} TX absent (${token}=${value})`);
        }
        break;
      }
      case "INTERFERENCE_STATUS":
      case "RF_INT_DET": {
        console.log(`[shure:${this.id}] ch${channel} RF interference: ${token}=${value}`);
        break;
      }
      default:
        console.debug(`[shure:${this.id}] ch${channel} unrecognised field: ${token}`);
        break;
    }
    this.emitStatus(channel);
  }
  // ── SAMPLE messages ───────────────────────────────────────────────────────
  // AD SAMPLE format (from Bitfocus shure-axient module):
  // SAMPLE {ch} ALL {quality} {audioLED} {audioPeak} {audioLevel} {antennaStr} {bmA} {rfA} {bmB} {rfB} ...
  // Indices:      0      1    2      3         4           5           6           7        8    9   10   11
  //
  // rfLevelA = tokens[9]  - 120
  // rfLevelB = tokens[11] - 120
  // rfBars   = max(tokens[8], tokens[10]) clamped 0..5 (these are bar values direct from device)
  // audioLvl = (tokens[6] - 120) normalised dB to 0..1
  handleSample(channel, tokens) {
    const state = this.channelStates.get(channel);
    if (!state) return;
    const bmA = safeInt(tokens[8]);
    const rfARaw = safeInt(tokens[9]);
    const bmB = safeInt(tokens[10]);
    const rfBRaw = safeInt(tokens[11]);
    const audioRaw = safeInt(tokens[6]);
    if (!Number.isNaN(bmA) && !Number.isNaN(bmB)) {
      state.rfBars = clamp(Math.max(bmA, bmB), 0, 5);
    }
    if (!Number.isNaN(rfARaw) && !Number.isNaN(rfBRaw)) {
      const dbmA = rfARaw - 120;
      const dbmB = rfBRaw - 120;
      const bestDbm = Math.max(dbmA, dbmB);
      state.rfLevelDbm = bestDbm;
      if (state.rfBars === null) {
        state.rfBars = rfBarsFromDbm(bestDbm);
      }
    }
    if (!Number.isNaN(audioRaw)) {
      const audioDb = audioRaw - 120;
      state.audioLevel = normalisedDb(audioDb, -60, 0);
    }
    console.debug(
      `[shure:${this.id}] ch${channel} SAMPLE rfDbm=${state.rfLevelDbm} rfBars=${state.rfBars} audio=${state.audioLevel?.toFixed(2)}`
    );
    this.emitStatus(channel);
  }
};

// main/providers/wireless/shure-psm.ts
var ShurePsm = class extends ShureBaseProvider {
  id = "shure-psm";
  label = "Shure PSM (In-Ear)";
  configSchema = [
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.101"
    },
    {
      key: "port",
      label: "TCP Port",
      type: "number",
      placeholder: "2202"
    },
    {
      key: "channels",
      label: "Number of Channels",
      type: "number",
      placeholder: "2"
    }
  ];
  defaultChannels = 2;
  defaultDeviceType = "iem";
  // RF-mute state tracked per channel to correctly derive online flag.
  rfMuted = /* @__PURE__ */ new Map();
  initChannelStates(count) {
    super.initChannelStates(count);
    this.rfMuted.clear();
    for (let n = 1; n <= count; n++) {
      this.rfMuted.set(n, false);
      const state = this.channelStates.get(n);
      if (state) {
        state.battery = null;
        state.rfBars = null;
        state.deviceType = "iem";
      }
    }
  }
  // ── Init commands ─────────────────────────────────────────────────────────
  onConnected() {
    console.log(`[shure:${this.id}] sending init commands`);
    const count = this.channelStates.size;
    for (let ch = 1; ch <= count; ch++) {
      this.send(`GET ${ch} CHAN_NAME`);
      this.send(`GET ${ch} FREQUENCY`);
      this.send(`GET ${ch} RF_MUTE`);
      this.send(`GET ${ch} AUDIO_IN_LVL`);
      this.send(`GET ${ch} RF_TX_LEVEL`);
      this.send(`SET ${ch} METER_RATE ${this.meterRateMs}`);
    }
  }
  // ── REP / REPORT messages ─────────────────────────────────────────────────
  handleReport(channel, token, rest) {
    if (channel === 0) {
      console.debug(`[shure:${this.id}] device-level REP: ${token} ${rest.join(" ")}`);
      return;
    }
    const state = this.channelStates.get(channel);
    if (!state) return;
    const value = rest.join(" ");
    switch (token) {
      case "CHAN_NAME": {
        state.name = stripBraces(value).slice(0, 8) || null;
        console.log(`[shure:${this.id}] ch${channel} name: ${state.name ?? "(none)"}`);
        break;
      }
      case "FREQUENCY": {
        state.frequencyLabel = formatFrequency(value);
        console.debug(`[shure:${this.id}] ch${channel} freq: ${state.frequencyLabel ?? value}`);
        break;
      }
      case "RF_MUTE": {
        const muted = value === "1";
        this.rfMuted.set(channel, muted);
        state.online = !muted;
        console.log(
          `[shure:${this.id}] ch${channel} RF_MUTE: ${muted ? "muted (offline)" : "active (online)"}`
        );
        break;
      }
      case "AUDIO_IN_LVL": {
        const db = safeInt(value);
        if (!Number.isNaN(db)) {
          state.audioLevel = normalisedDb(clamp(db, -67, 0), -67, 0);
        }
        console.debug(`[shure:${this.id}] ch${channel} AUDIO_IN_LVL: ${value} dB`);
        break;
      }
      case "RF_TX_LEVEL": {
        console.debug(`[shure:${this.id}] ch${channel} RF_TX_LEVEL: ${value} mW`);
        break;
      }
      default:
        console.debug(`[shure:${this.id}] ch${channel} unrecognised field: ${token}`);
        break;
    }
    this.emitStatus(channel);
  }
  // ── SAMPLE messages ───────────────────────────────────────────────────────
  // PSM does not send SAMPLE messages. If one arrives unexpectedly, ignore it.
  handleSample(channel, _tokens) {
    console.debug(`[shure:${this.id}] ch${channel} unexpected SAMPLE \u2014 ignoring (PSM is TX-only)`);
  }
};

// main/providers/wireless/shure-ulxd.ts
var ShureUlxd = class extends ShureBaseProvider {
  id = "shure-ulxd";
  label = "Shure ULX-D";
  configSchema = [
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.100"
    },
    {
      key: "port",
      label: "TCP Port",
      type: "number",
      placeholder: "2202"
    },
    {
      key: "channels",
      label: "Number of Channels",
      type: "number",
      placeholder: "4"
    }
  ];
  defaultChannels = 4;
  defaultDeviceType = "receiver";
  // ── Init commands ─────────────────────────────────────────────────────────
  onConnected() {
    console.log(`[shure:${this.id}] sending init commands`);
    this.send("GET 0 ALL");
    this.send(`SET 0 METER_RATE ${this.meterRateMs}`);
  }
  // ── REP / REPORT messages ─────────────────────────────────────────────────
  handleReport(channel, token, rest) {
    if (channel === 0) {
      console.debug(`[shure:${this.id}] device-level REP: ${token} ${rest.join(" ")}`);
      return;
    }
    const state = this.channelStates.get(channel);
    if (!state) return;
    const value = rest.join(" ");
    switch (token) {
      case "CHAN_NAME": {
        state.name = stripBraces(value) || null;
        console.log(`[shure:${this.id}] ch${channel} name: ${state.name ?? "(none)"}`);
        break;
      }
      case "BATT_BARS": {
        const bars = safeInt(value);
        if (!Number.isNaN(bars)) {
          if (bars === 255) {
            state.battery = null;
            state.online = false;
          } else {
            state.battery = state.battery ?? bars * 20;
            state.online = true;
          }
        }
        console.debug(`[shure:${this.id}] ch${channel} BATT_BARS: ${value}`);
        break;
      }
      case "BATT_CHARGE": {
        const charge = safeInt(value);
        if (!Number.isNaN(charge)) {
          state.battery = charge === 255 ? null : clamp(charge, 0, 100);
        }
        console.debug(`[shure:${this.id}] ch${channel} BATT_CHARGE: ${value}`);
        break;
      }
      case "FREQUENCY": {
        state.frequencyLabel = formatFrequency(value);
        console.debug(`[shure:${this.id}] ch${channel} freq: ${state.frequencyLabel ?? value}`);
        break;
      }
      case "MUTE_STATUS": {
        console.debug(`[shure:${this.id}] ch${channel} MUTE_STATUS: ${value}`);
        break;
      }
      case "TX_TYPE":
      case "TX_MODEL": {
        if (value === "UNKNOWN" || value === "UNKN") {
          state.online = false;
          console.log(`[shure:${this.id}] ch${channel} TX absent (${token}=${value})`);
        }
        break;
      }
      default:
        console.debug(`[shure:${this.id}] ch${channel} unrecognised field: ${token}`);
        break;
    }
    this.emitStatus(channel);
  }
  // ── SAMPLE messages ───────────────────────────────────────────────────────
  // Format: SAMPLE {ch} ALL {antenna} {rfRaw} {audioRaw}
  // rfLevelDbm = rfRaw - 128; audioRaw - 50 gives audio dB (range ~-50..0).
  handleSample(channel, tokens) {
    const state = this.channelStates.get(channel);
    if (!state) return;
    const rfRaw = safeInt(tokens[4]);
    const audioRaw = safeInt(tokens[5]);
    if (!Number.isNaN(rfRaw)) {
      const dbm = rfRaw - 128;
      state.rfLevelDbm = dbm;
      state.rfBars = rfBarsFromDbm(dbm);
    }
    if (!Number.isNaN(audioRaw)) {
      const audioDb = audioRaw - 50;
      state.audioLevel = normalisedDb(audioDb, -50, 0);
    }
    console.debug(
      `[shure:${this.id}] ch${channel} SAMPLE rfDbm=${state.rfLevelDbm} rfBars=${state.rfBars} audio=${state.audioLevel?.toFixed(2)}`
    );
    this.emitStatus(channel);
  }
};

// main/providers/registry.ts
function shureFields(channelsPlaceholder) {
  return [
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.100"
    },
    {
      key: "port",
      label: "TCP Port",
      type: "number",
      placeholder: "2202"
    },
    {
      key: "channels",
      label: "Number of Channels",
      type: "number",
      placeholder: channelsPlaceholder
    }
  ];
}
var DRIVER_IDS = /* @__PURE__ */ new Set(["none", "shure-ulxd", "shure-axient", "shure-psm"]);
var PROVIDER_DESCRIPTORS = /* @__PURE__ */ new Map([
  [
    "none",
    { id: "none", kind: "wireless", label: "None", configSchema: [] }
  ],
  [
    "shure-axient",
    {
      id: "shure-axient",
      kind: "wireless",
      label: "Shure Axient Digital",
      configSchema: shureFields("4")
    }
  ],
  [
    "shure-psm",
    {
      id: "shure-psm",
      kind: "wireless",
      label: "Shure PSM (In-Ear)",
      configSchema: shureFields("2")
    }
  ],
  [
    "shure-ulxd",
    {
      id: "shure-ulxd",
      kind: "wireless",
      label: "Shure ULX-D",
      configSchema: shureFields("4")
    }
  ]
]);
var ProviderRegistry = class {
  getDescriptors() {
    return Array.from(PROVIDER_DESCRIPTORS.values());
  }
  getDescriptor(id) {
    return PROVIDER_DESCRIPTORS.get(id) ?? null;
  }
  /**
   * Creates and returns a NEW provider instance for providers that have a real
   * driver. Returns null for unknown provider ids.
   * Callers are responsible for the lifecycle of the returned instance.
   */
  createProvider(id) {
    switch (id) {
      case "none":
        return new NoneProvider();
      case "shure-ulxd":
        return new ShureUlxd();
      case "shure-axient":
        return new ShureAxient();
      case "shure-psm":
        return new ShurePsm();
      default:
        return null;
    }
  }
  /** True when the provider has a real driver. */
  hasDriver(id) {
    return DRIVER_IDS.has(id);
  }
};
var providerRegistry = new ProviderRegistry();

// main/services/stage-controller.ts
init_pco_service();
import { randomUUID } from "crypto";
import { ipcMain } from "@glaze/core/backend";

// main/services/data-store.ts
import * as fs from "fs/promises";
import * as path from "path";
import { app } from "@glaze/core/backend";
var DataStore = class {
  constructor(filename, defaultValue) {
    this.filename = filename;
    this.defaultValue = defaultValue;
  }
  filename;
  defaultValue;
  cache = null;
  filePath = null;
  async getFilePath() {
    if (!this.filePath) {
      const userDataPath = await app.getPath("userData");
      await fs.mkdir(userDataPath, { recursive: true });
      this.filePath = path.join(userDataPath, this.filename);
    }
    return this.filePath;
  }
  async load() {
    if (this.cache !== null) return this.cache;
    try {
      const filePath = await this.getFilePath();
      const data = await fs.readFile(filePath, "utf-8");
      this.cache = JSON.parse(data);
      return this.cache;
    } catch {
      this.cache = this.defaultValue;
      return this.cache;
    }
  }
  async save(data) {
    this.cache = data;
    const filePath = await this.getFilePath();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
  /** Reload from disk, discarding the in-memory cache. */
  async reload() {
    this.cache = null;
    return this.load();
  }
};

// main/services/presets-store.ts
var store = new DataStore("presets.json", []);
var presetsStore = {
  async load() {
    return store.load();
  },
  async save(presets) {
    return store.save(presets);
  }
};

// main/services/slot-resolver.ts
var EMPTY_DEVICE = {
  status: "none",
  rf: null,
  battery: null,
  freq: null,
  audioLevel: null
};
function deviceStatusToSlotDevice(ds) {
  if (!ds.online) {
    return { status: "error", rf: null, battery: null, freq: ds.frequencyLabel, audioLevel: null };
  }
  let status = "ok";
  if (ds.rfBars !== null && ds.rfBars <= 1) status = "warn";
  if (ds.battery !== null && ds.battery <= 20) status = "warn";
  if (ds.battery !== null && ds.battery <= 5) status = "error";
  return {
    status,
    rf: ds.rfBars,
    battery: ds.battery,
    freq: ds.frequencyLabel,
    audioLevel: ds.audioLevel
  };
}
function matchMember(slot, members) {
  const { link } = slot;
  if (link.kind !== "pco") return null;
  if (link.matchBy === "person") {
    return members.find((m) => m.personId === link.personId) ?? null;
  }
  if (link.matchBy === "position") {
    const pos = link.teamPositionName.toLowerCase();
    return members.find((m) => (m.teamPositionName ?? "").toLowerCase() === pos) ?? null;
  }
  return null;
}
function resolveSlots(slots, members, deviceStatuses) {
  return slots.map((slot) => {
    if (slot.link.kind === "empty") {
      return { ...slot, displayName: null, photoUrl: null, device: EMPTY_DEVICE };
    }
    if (slot.link.kind === "static") {
      let device2 = EMPTY_DEVICE;
      if (slot.deviceBinding) {
        const ds = deviceStatuses.get(slot.deviceBinding.channelId);
        if (ds) device2 = deviceStatusToSlotDevice(ds);
      }
      return { ...slot, device: device2 };
    }
    const member = matchMember(slot, members);
    let device = EMPTY_DEVICE;
    if (slot.deviceBinding) {
      const ds = deviceStatuses.get(slot.deviceBinding.channelId);
      if (ds) device = deviceStatusToSlotDevice(ds);
    }
    return {
      ...slot,
      displayName: member?.name ?? null,
      photoUrl: member?.photoUrl ?? null,
      device
    };
  });
}

// main/services/settings-store.ts
var DEFAULT_SETTINGS = {
  serviceTypeId: null,
  serviceTypeName: null,
  planMode: "auto",
  planId: null,
  planTitle: null,
  planSeriesTitle: null,
  integrationConfigs: {},
  integrationEnabled: {},
  showQr: true,
  displays: [{ id: "display-1", name: "Display 1" }],
  allowedServiceTypeIds: ["41227", "61695", "75953", "249176"],
  wirelessMeterRateMs: 1e3
};
var store2 = new DataStore("settings.json", DEFAULT_SETTINGS);
var settingsStore = {
  async load() {
    return store2.load();
  },
  async save(data) {
    return store2.save(data);
  },
  async get() {
    return store2.load();
  },
  async patch(partial) {
    const current = await store2.load();
    const updated = { ...current, ...partial };
    await store2.save(updated);
    return updated;
  }
};

// main/services/slots-store.ts
var store3 = new DataStore("slots.json", {});
async function loadNormalised() {
  const raw = await store3.load();
  if (Array.isArray(raw)) {
    const migrated = { "display-1": { default: raw } };
    await store3.save(migrated);
    console.log("[slots-store] migrated v0 (flat array) \u2192 display-1/default");
    return migrated;
  }
  const values = Object.values(raw);
  if (values.length > 0 && Array.isArray(values[0])) {
    const migrated = { "display-1": raw };
    await store3.save(migrated);
    console.log("[slots-store] migrated v1 (serviceType map) \u2192 display-1");
    return migrated;
  }
  return raw;
}
var slotsStore = {
  async getSlots(displayId, serviceTypeId) {
    const map = await loadNormalised();
    return map[displayId]?.[serviceTypeId] ?? [];
  },
  async setSlots(displayId, serviceTypeId, slots) {
    const map = await loadNormalised();
    if (!map[displayId]) map[displayId] = {};
    map[displayId][serviceTypeId] = slots;
    await store3.save(map);
  },
  // One-time recovery for display-1: if the active service type has no slots but
  // the legacy "default" bucket has some, adopt them and clear the bucket.
  async adoptDefaultInto(displayId, serviceTypeId) {
    const map = await loadNormalised();
    const displayMap = map[displayId] ?? {};
    const existing = displayMap[serviceTypeId] ?? [];
    const fallback = displayMap["default"] ?? [];
    if (existing.length === 0 && fallback.length > 0) {
      displayMap[serviceTypeId] = fallback;
      delete displayMap["default"];
      map[displayId] = displayMap;
      await store3.save(map);
      console.log(`[slots-store] adoptDefaultInto display=${displayId} serviceType=${serviceTypeId} (${fallback.length} slots)`);
      return fallback;
    }
    return existing;
  },
  async removeDisplay(displayId) {
    const map = await loadNormalised();
    if (displayId in map) {
      delete map[displayId];
      await store3.save(map);
      console.log(`[slots-store] removeDisplay ${displayId}`);
    }
  }
};

// main/services/stage-controller.ts
var PRIMARY_DISPLAY_ID = "display-1";
var StageController = class {
  state = {
    serviceTypeId: null,
    serviceTypeName: null,
    planMode: "auto",
    planId: null,
    planTitle: null,
    planSeriesTitle: null,
    slots: [],
    slotsByDisplay: {},
    displays: [{ id: PRIMARY_DISPLAY_ID, name: "Display 1" }],
    pcoConfigured: false,
    lastRefreshedAt: null,
    remoteUrl: null,
    showQr: true,
    allowedServiceTypeIds: ["41227", "61695", "75953", "249176"]
  };
  // Live device statuses keyed by channelId.
  deviceStatuses = /* @__PURE__ */ new Map();
  // Cached team members for the active plan.
  teamMembers = [];
  // Raw (un-resolved) slot configs per displayId for the ACTIVE service type.
  rawSlotsByDisplay = /* @__PURE__ */ new Map();
  // PCO credentials (set by IntegrationManager after config saves).
  pcoAppId = null;
  pcoSecret = null;
  // Hourly auto-refresh of the active plan.
  autoRefreshTimer = null;
  isRefreshing = false;
  // ── Init ─────────────────────────────────────────────────────────────
  async init() {
    console.log("[stage-controller] init");
    const settings = await settingsStore.load();
    const showQr = settings.showQr ?? true;
    const displays = settings.displays && settings.displays.length > 0 ? settings.displays : [{ id: PRIMARY_DISPLAY_ID, name: "Display 1" }];
    const allowedServiceTypeIds = Array.isArray(settings.allowedServiceTypeIds) && settings.allowedServiceTypeIds.length > 0 ? settings.allowedServiceTypeIds : ["41227", "61695", "75953", "249176"];
    this.state = {
      ...this.state,
      serviceTypeId: settings.serviceTypeId,
      serviceTypeName: settings.serviceTypeName,
      planMode: settings.planMode,
      planId: settings.planId,
      planTitle: settings.planTitle,
      planSeriesTitle: settings.planSeriesTitle ?? null,
      displays,
      showQr,
      allowedServiceTypeIds
    };
    this.rawSlotsByDisplay.clear();
    for (const display of displays) {
      if (settings.serviceTypeId) {
        const slots = display.id === PRIMARY_DISPLAY_ID ? await slotsStore.adoptDefaultInto(display.id, settings.serviceTypeId) : await slotsStore.getSlots(display.id, settings.serviceTypeId);
        this.rawSlotsByDisplay.set(display.id, slots);
      } else {
        this.rawSlotsByDisplay.set(display.id, []);
      }
    }
    await this.reResolveAll();
    console.log("[stage-controller] loaded settings", {
      serviceTypeId: this.state.serviceTypeId,
      planId: this.state.planId,
      planMode: this.state.planMode,
      showQr: this.state.showQr,
      displays: displays.length,
      allowedServiceTypeIds: this.state.allowedServiceTypeIds
    });
  }
  // ── PCO credentials ───────────────────────────────────────────────────
  setPcoCredentials(appId, secret) {
    this.pcoAppId = appId;
    this.pcoSecret = secret;
    this.state = { ...this.state, pcoConfigured: !!(appId && secret) };
  }
  // ── Remote URL ────────────────────────────────────────────────────────
  setRemoteUrl(url) {
    this.state = { ...this.state, remoteUrl: url };
  }
  // ── Public state ──────────────────────────────────────────────────────
  getState() {
    return { ...this.state };
  }
  getDisplays() {
    return [...this.state.displays];
  }
  // ── Service type ──────────────────────────────────────────────────────
  async listServiceTypes() {
    this.assertPco();
    return pcoService.listServiceTypes(this.pcoAppId, this.pcoSecret);
  }
  async setServiceType(id) {
    this.assertPco();
    const types = await pcoService.listServiceTypes(this.pcoAppId, this.pcoSecret);
    const found = types.find((t) => t.id === id);
    if (!found) throw new Error(`Service type ${id} not found`);
    console.log(`[stage-controller] setServiceType \u2192 ${id} (${found.name})`);
    this.state = {
      ...this.state,
      serviceTypeId: id,
      serviceTypeName: found.name,
      planId: null,
      planTitle: null,
      planSeriesTitle: null
    };
    this.teamMembers = [];
    await this.loadAllDisplayRawSlots(id);
    await settingsStore.patch({
      serviceTypeId: id,
      serviceTypeName: found.name,
      planId: null,
      planTitle: null,
      planSeriesTitle: null
    });
    if (this.state.planMode === "auto") {
      await this.selectNextPlan();
      return this.state;
    }
    await this.reResolveAll();
    this.broadcast();
    return this.state;
  }
  // ── Plans ──────────────────────────────────────────────────────────────
  async listPlans(serviceTypeId) {
    this.assertPco();
    return pcoService.listUpcomingPlans(this.pcoAppId, this.pcoSecret, serviceTypeId);
  }
  async setPlan(id) {
    this.assertPco();
    if (!this.state.serviceTypeId) throw new Error("No service type selected");
    const plans = await pcoService.listUpcomingPlans(
      this.pcoAppId,
      this.pcoSecret,
      this.state.serviceTypeId
    );
    const found = plans.find((p) => p.id === id);
    if (!found) throw new Error(`Plan ${id} not found`);
    console.log(`[stage-controller] setPlan \u2192 ${id} (${found.title})`);
    await this.applyPlan(found);
    return this.state;
  }
  async selectNextPlan() {
    this.assertPco();
    if (!this.state.serviceTypeId) throw new Error("No service type selected");
    const plans = await pcoService.listUpcomingPlans(
      this.pcoAppId,
      this.pcoSecret,
      this.state.serviceTypeId
    );
    if (plans.length === 0) {
      console.log("[stage-controller] selectNextPlan: no upcoming plans");
      this.state = { ...this.state, planId: null, planTitle: null, planSeriesTitle: null };
      this.teamMembers = [];
      await settingsStore.patch({ planId: null, planTitle: null, planSeriesTitle: null });
      await this.reResolveAll();
      this.broadcast();
      return this.state;
    }
    const next = plans[0];
    console.log(`[stage-controller] selectNextPlan \u2192 ${next.id} (${next.title})`);
    await this.applyPlan(next);
    return this.state;
  }
  /**
   * Cross-service-type auto-follow: finds the nearest upcoming plan across all
   * allowed service types and switches to it. Empty allowedServiceTypeIds = all
   * service types are candidates.
   */
  async selectGlobalNextPlan() {
    this.assertPco();
    console.log("[stage-controller] selectGlobalNextPlan \u2014 scanning allowed service types");
    const allTypes = await pcoService.listServiceTypes(this.pcoAppId, this.pcoSecret);
    const allowed = this.state.allowedServiceTypeIds;
    const candidates = allowed.length === 0 ? allTypes : allTypes.filter((t) => allowed.includes(t.id));
    console.log(
      `[stage-controller] selectGlobalNextPlan \u2014 ${candidates.length} candidate types: ${candidates.map((c) => c.id).join(", ")}`
    );
    let best = null;
    for (const type of candidates) {
      try {
        const plans = await pcoService.listUpcomingPlans(this.pcoAppId, this.pcoSecret, type.id);
        if (plans.length === 0) continue;
        const nearest = plans[0];
        if (best === null || nearest.sortDate !== null && (best.plan.sortDate === null || nearest.sortDate < best.plan.sortDate)) {
          best = { type, plan: nearest };
        }
      } catch (err) {
        console.error(`[stage-controller] selectGlobalNextPlan \u2014 error fetching plans for type ${type.id}:`, err);
      }
    }
    if (!best) {
      console.log("[stage-controller] selectGlobalNextPlan \u2014 no upcoming plans found across all candidates");
      this.state = {
        ...this.state,
        planId: null,
        planTitle: null,
        planSeriesTitle: null,
        lastRefreshedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.teamMembers = [];
      await settingsStore.patch({ planId: null, planTitle: null, planSeriesTitle: null });
      await this.reResolveAll();
      this.broadcast();
      return this.state;
    }
    console.log(
      `[stage-controller] selectGlobalNextPlan \u2192 type=${best.type.id} (${best.type.name}) plan=${best.plan.id} (${best.plan.title}) sortDate=${best.plan.sortDate}`
    );
    if (this.state.serviceTypeId !== best.type.id) {
      this.state = {
        ...this.state,
        serviceTypeId: best.type.id,
        serviceTypeName: best.type.name,
        planId: null,
        planTitle: null,
        planSeriesTitle: null
      };
      this.teamMembers = [];
      await this.loadAllDisplayRawSlots(best.type.id);
      await settingsStore.patch({
        serviceTypeId: best.type.id,
        serviceTypeName: best.type.name
      });
    }
    await this.applyPlan(best.plan);
    return this.state;
  }
  async setAllowedServiceTypes(ids) {
    console.log(`[stage-controller] setAllowedServiceTypes \u2192 [${ids.join(", ")}]`);
    this.state = { ...this.state, allowedServiceTypeIds: ids };
    await settingsStore.patch({ allowedServiceTypeIds: ids });
    ipcMain.broadcast("settings:allowedServiceTypeIds-changed", { value: ids });
    if (this.state.planMode === "auto") {
      await this.selectGlobalNextPlan();
      return this.state;
    }
    this.broadcast();
    return this.state;
  }
  async setPlanMode(mode) {
    console.log(`[stage-controller] setPlanMode \u2192 ${mode}`);
    this.state = { ...this.state, planMode: mode };
    await settingsStore.patch({ planMode: mode });
    if (mode === "auto") {
      await this.selectGlobalNextPlan();
      return this.state;
    }
    this.broadcast();
    return this.state;
  }
  // ── Slots ─────────────────────────────────────────────────────────────
  async setSlots(displayId, slots) {
    const effectiveDisplayId = displayId || this.primaryDisplayId();
    if (!this.state.serviceTypeId) {
      console.log("[stage-controller] setSlots: no active service type \u2014 slots not persisted");
    } else {
      console.log(`[stage-controller] setSlots (${slots.length} slots) for display=${effectiveDisplayId} serviceType=${this.state.serviceTypeId}`);
      await slotsStore.setSlots(effectiveDisplayId, this.state.serviceTypeId, slots);
    }
    this.rawSlotsByDisplay.set(effectiveDisplayId, slots);
    await this.reResolveAll();
    this.broadcast();
    return this.state;
  }
  // ── QR visibility ─────────────────────────────────────────────────────
  async setShowQr(show) {
    console.log(`[stage-controller] setShowQr \u2192 ${show}`);
    this.state = { ...this.state, showQr: show };
    await settingsStore.patch({ showQr: show });
    this.broadcast();
    return this.state;
  }
  // ── Presets ───────────────────────────────────────────────────────────
  async listPresets() {
    return presetsStore.load();
  }
  async savePreset(displayId, name) {
    const effectiveDisplayId = displayId || this.primaryDisplayId();
    console.log(`[stage-controller] savePreset "${name}" for display=${effectiveDisplayId}`);
    const presets = await presetsStore.load();
    const rawSlots = this.rawSlotsByDisplay.get(effectiveDisplayId) ?? [];
    const newPreset = {
      id: randomUUID(),
      name,
      // Deep-clone with fresh slot ids so preset slots are independent.
      slots: rawSlots.map((s) => ({ ...s, id: randomUUID() })),
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const updated = [...presets, newPreset];
    await presetsStore.save(updated);
    return updated;
  }
  async applyPreset(displayId, id) {
    const effectiveDisplayId = displayId || this.primaryDisplayId();
    const presets = await presetsStore.load();
    const preset = presets.find((p) => p.id === id);
    if (!preset) throw new Error(`Preset ${id} not found`);
    console.log(`[stage-controller] applyPreset "${preset.name}" (${id}) for display=${effectiveDisplayId}`);
    const slots = preset.slots.map((s) => ({ ...s, id: randomUUID() }));
    if (this.state.serviceTypeId) {
      await slotsStore.setSlots(effectiveDisplayId, this.state.serviceTypeId, slots);
    }
    this.rawSlotsByDisplay.set(effectiveDisplayId, slots);
    await this.reResolveAll();
    this.broadcast();
    return this.state;
  }
  async deletePreset(id) {
    console.log(`[stage-controller] deletePreset ${id}`);
    const presets = await presetsStore.load();
    const updated = presets.filter((p) => p.id !== id);
    await presetsStore.save(updated);
    return updated;
  }
  // ── Displays ──────────────────────────────────────────────────────────
  async addDisplay(name) {
    const id = `display-${randomUUID()}`;
    const displayName = name?.trim() || `Display ${this.state.displays.length + 1}`;
    const newDisplay = { id, name: displayName };
    console.log(`[stage-controller] addDisplay id=${id} name="${displayName}"`);
    const displays = [...this.state.displays, newDisplay];
    this.state = { ...this.state, displays };
    await settingsStore.patch({ displays });
    this.rawSlotsByDisplay.set(id, []);
    await this.reResolveAll();
    this.broadcast();
    return this.state;
  }
  async renameDisplay(id, name) {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("displays:rename \u2014 name must be non-empty");
    const displays = this.state.displays.map(
      (d) => d.id === id ? { ...d, name: trimmedName } : d
    );
    if (!displays.find((d) => d.id === id)) {
      throw new Error(`displays:rename \u2014 display ${id} not found`);
    }
    console.log(`[stage-controller] renameDisplay id=${id} name="${trimmedName}"`);
    this.state = { ...this.state, displays };
    await settingsStore.patch({ displays });
    this.broadcast();
    return this.state;
  }
  async removeDisplay(id) {
    if (this.state.displays.length <= 1) {
      throw new Error("displays:remove \u2014 cannot remove the last display");
    }
    if (!this.state.displays.find((d) => d.id === id)) {
      throw new Error(`displays:remove \u2014 display ${id} not found`);
    }
    console.log(`[stage-controller] removeDisplay id=${id}`);
    const displays = this.state.displays.filter((d) => d.id !== id);
    this.state = { ...this.state, displays };
    await settingsStore.patch({ displays });
    await slotsStore.removeDisplay(id);
    this.rawSlotsByDisplay.delete(id);
    await this.reResolveAll();
    this.broadcast();
    return this.state;
  }
  // ── Refresh ───────────────────────────────────────────────────────────
  async refresh() {
    console.log("[stage-controller] refresh");
    pcoService.clearCache();
    if (this.state.planMode === "auto") {
      await this.selectGlobalNextPlan();
      return this.state;
    }
    if (this.state.serviceTypeId && this.state.planId) {
      await this.fetchTeamMembers(this.state.serviceTypeId, this.state.planId);
    }
    await this.reResolveAll();
    this.state = { ...this.state, lastRefreshedAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.broadcast();
    return this.state;
  }
  // ── Auto-refresh ───────────────────────────────────────────────────────
  startAutoRefresh(intervalMs = 60 * 60 * 1e3) {
    this.stopAutoRefresh();
    console.log(`[stage-controller] auto-refresh every ${Math.round(intervalMs / 6e4)} min`);
    this.autoRefreshTimer = setInterval(() => {
      void this.autoRefreshTick();
    }, intervalMs);
  }
  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }
  async autoRefreshTick() {
    if (this.isRefreshing) return;
    if (!this.state.pcoConfigured || !this.state.serviceTypeId) return;
    this.isRefreshing = true;
    try {
      console.log("[stage-controller] auto-refresh tick");
      await this.refresh();
    } catch (err) {
      console.error("[stage-controller] auto-refresh failed:", err);
    } finally {
      this.isRefreshing = false;
    }
  }
  // ── Device status ──────────────────────────────────────────────────────
  applyDeviceStatus(channelId, status) {
    this.deviceStatuses.set(channelId, status);
    const slotsByDisplay = {};
    for (const display of this.state.displays) {
      const raw = this.rawSlotsByDisplay.get(display.id) ?? [];
      slotsByDisplay[display.id] = resolveSlots(raw, this.teamMembers, this.deviceStatuses);
    }
    const primarySlots = slotsByDisplay[this.primaryDisplayId()] ?? [];
    this.state = {
      ...this.state,
      slotsByDisplay,
      slots: primarySlots
    };
    this.broadcast();
  }
  // ── Internals ─────────────────────────────────────────────────────────
  primaryDisplayId() {
    return this.state.displays[0]?.id ?? PRIMARY_DISPLAY_ID;
  }
  assertPco() {
    if (!this.pcoAppId || !this.pcoSecret) {
      throw new Error("PCO not configured \u2014 add App ID and Secret in Integrations settings");
    }
  }
  async applyPlan(plan) {
    this.state = {
      ...this.state,
      planId: plan.id,
      planTitle: plan.title,
      planSeriesTitle: plan.seriesTitle
    };
    await settingsStore.patch({
      planId: plan.id,
      planTitle: plan.title,
      planSeriesTitle: plan.seriesTitle
    });
    if (this.state.serviceTypeId) {
      await this.fetchTeamMembers(this.state.serviceTypeId, plan.id);
    }
    await this.reResolveAll();
    this.state = { ...this.state, lastRefreshedAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.broadcast();
  }
  async fetchTeamMembers(serviceTypeId, planId) {
    try {
      this.teamMembers = await pcoService.listTeamMembers(
        this.pcoAppId,
        this.pcoSecret,
        serviceTypeId,
        planId
      );
      console.log(`[stage-controller] fetched ${this.teamMembers.length} team members`);
    } catch (err) {
      console.error("[stage-controller] fetchTeamMembers error:", err);
      this.teamMembers = [];
    }
  }
  /** Load raw slots for every display for the given service type. */
  async loadAllDisplayRawSlots(serviceTypeId) {
    for (const display of this.state.displays) {
      const slots = await slotsStore.getSlots(display.id, serviceTypeId);
      this.rawSlotsByDisplay.set(display.id, slots);
    }
  }
  /** Re-resolve all displays and update state.slotsByDisplay + state.slots. */
  async reResolveAll() {
    const slotsByDisplay = {};
    for (const display of this.state.displays) {
      const raw = this.rawSlotsByDisplay.get(display.id) ?? [];
      slotsByDisplay[display.id] = resolveSlots(raw, this.teamMembers, this.deviceStatuses);
    }
    const primarySlots = slotsByDisplay[this.primaryDisplayId()] ?? [];
    this.state = {
      ...this.state,
      slotsByDisplay,
      slots: primarySlots
    };
  }
  broadcast() {
    ipcMain.broadcast("stage:state-changed", this.state);
  }
};
var stageController = new StageController();

// main/services/device-manager.ts
var DeviceManager = class {
  // connectionId → live provider entry
  entries = /* @__PURE__ */ new Map();
  // Global metering/polling interval (ms) applied to every provider on connect.
  meterRateMs = 1e3;
  /** Set the global metering interval. Takes effect for connections opened after this. */
  setMeterRate(ms) {
    this.meterRateMs = Math.max(0, Math.floor(ms));
    console.log(`[device-manager] meter rate set to ${this.meterRateMs}ms`);
  }
  async start() {
    console.log("[device-manager] start");
  }
  async stop() {
    console.log("[device-manager] stop \u2014 disconnecting all connections");
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
  async applyConnections(connections) {
    console.log(`[device-manager] applyConnections \u2014 ${connections.length} connection(s)`);
    const enabledWithDriver = /* @__PURE__ */ new Set();
    for (const conn of connections) {
      if (conn.enabled && providerRegistry.hasDriver(conn.providerId)) {
        enabledWithDriver.add(conn.id);
      }
    }
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
    for (const conn of connections) {
      if (!conn.enabled) {
        conn.connection = "disconnected";
        conn.message = null;
        continue;
      }
      if (!providerRegistry.hasDriver(conn.providerId)) {
        const desc = providerRegistry.getDescriptor(conn.providerId);
        conn.connection = "disconnected";
        conn.message = `${desc?.label ?? conn.providerId}: driver arrives in a future update`;
        continue;
      }
      const existing = this.entries.get(conn.id);
      if (existing) {
        existing.connectionName = conn.name;
        conn.connection = existing.provider.getConnectionState();
        conn.message = null;
        continue;
      }
      const provider = providerRegistry.createProvider(conn.providerId);
      if (!provider) {
        conn.connection = "error";
        conn.message = `Failed to create provider: ${conn.providerId}`;
        continue;
      }
      const connectionId = conn.id;
      const connectionName = conn.name;
      provider.onStatus((status) => {
        const namespacedId = `${connectionId}::${status.channelId}`;
        stageController.applyDeviceStatus(namespacedId, { ...status, channelId: namespacedId });
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
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[device-manager] connect error for ${connectionId}:`, msg);
        conn.connection = "error";
        conn.message = `Connection failed: ${msg}`;
      }
    }
  }
  /** Aggregate channels from all connected real-driver providers. */
  async listChannels() {
    const results = [];
    for (const entry of this.entries.values()) {
      try {
        const channels = await entry.provider.listChannels();
        for (const ch of channels) {
          results.push({
            id: `${entry.connectionId}::${ch.id}`,
            label: `${entry.connectionName} \u2014 ${ch.label}`
          });
        }
      } catch (err) {
        console.error(`[device-manager] listChannels error for ${entry.connectionId}:`, err);
      }
    }
    return results;
  }
  /** Summary connection state: "connected" if ANY entry is connected. */
  getConnectionState() {
    if (this.entries.size === 0) return "disconnected";
    for (const entry of this.entries.values()) {
      if (entry.provider.getConnectionState() === "connected") return "connected";
    }
    return "disconnected";
  }
  async disconnectAll() {
    for (const [id, entry] of this.entries) {
      try {
        await entry.provider.disconnect();
      } catch (err) {
        console.error(`[device-manager] disconnect error for ${id}:`, err);
      }
    }
    this.entries.clear();
  }
};
var deviceManager = new DeviceManager();

// main/services/integration-manager.ts
import { ipcMain as ipcMain3 } from "@glaze/core/backend";

// main/services/secrets.ts
import * as fs2 from "fs/promises";
import * as path2 from "path";
import { app as app2, safeStorage } from "@glaze/core/backend";
var SecretsStore = class {
  cache = null;
  filePath = null;
  encryptionAvailableCache = null;
  // Glaze's safeStorage proxies to the native host, so these calls are async
  // (unlike Electron's synchronous safeStorage). Result is cached after first use.
  async isEncryptionAvailable() {
    if (this.encryptionAvailableCache === null) {
      this.encryptionAvailableCache = await safeStorage.isEncryptionAvailable();
    }
    return this.encryptionAvailableCache;
  }
  async getFilePath() {
    if (!this.filePath) {
      const userDataPath = await app2.getPath("userData");
      await fs2.mkdir(userDataPath, { recursive: true });
      this.filePath = path2.join(userDataPath, "secrets.bin");
    }
    return this.filePath;
  }
  async load() {
    if (this.cache !== null) return this.cache;
    try {
      const filePath = await this.getFilePath();
      const raw = await fs2.readFile(filePath);
      if (!await this.isEncryptionAvailable()) {
        this.cache = JSON.parse(raw.toString("utf-8"));
      } else {
        const decrypted = await safeStorage.decryptString(raw);
        this.cache = JSON.parse(decrypted);
      }
      return this.cache;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }
  async persist() {
    const filePath = await this.getFilePath();
    const json2 = JSON.stringify(this.cache ?? {});
    if (!await this.isEncryptionAvailable()) {
      await fs2.writeFile(filePath, json2, "utf-8");
    } else {
      const encrypted = await safeStorage.encryptString(json2);
      await fs2.writeFile(filePath, encrypted);
    }
  }
  async getSecrets(integrationId) {
    const blob = await this.load();
    return blob[integrationId] ?? {};
  }
  async setSecret(integrationId, key, value) {
    const blob = await this.load();
    blob[integrationId] = { ...blob[integrationId] ?? {}, [key]: value };
    await this.persist();
  }
  async setSecrets(integrationId, secrets) {
    const blob = await this.load();
    blob[integrationId] = secrets;
    await this.persist();
  }
  async clearSecrets(integrationId) {
    const blob = await this.load();
    delete blob[integrationId];
    await this.persist();
  }
};
var secretsStore = new SecretsStore();

// main/services/wireless-manager.ts
import { randomUUID as randomUUID2 } from "crypto";
import { ipcMain as ipcMain2 } from "@glaze/core/backend";

// main/services/wireless-store.ts
var store4 = new DataStore("wireless-connections.json", []);
var wirelessStore = {
  async load() {
    return store4.load();
  },
  async save(connections) {
    return store4.save(connections);
  }
};

// main/services/wireless-manager.ts
var WirelessManager = class {
  // In-memory list of connections including runtime fields.
  connections = [];
  // Global metering/polling interval (ms) applied to all wireless gear.
  meterRateMs = 1e3;
  // ── Init ──────────────────────────────────────────────────────────────
  async init() {
    console.log("[wireless] init");
    const settings = await settingsStore.load();
    this.meterRateMs = settings.wirelessMeterRateMs ?? 1e3;
    deviceManager.setMeterRate(this.meterRateMs);
    const configs = await wirelessStore.load();
    this.connections = configs.map((cfg) => ({
      ...cfg,
      connection: "disconnected",
      message: null
    }));
    await deviceManager.applyConnections(this.connections);
    console.log(`[wireless] init complete \u2014 ${this.connections.length} connection(s), meterRate=${this.meterRateMs}ms`);
  }
  // ── Metering interval ───────────────────────────────────────────────────
  getMeterRate() {
    return this.meterRateMs;
  }
  async setMeterRate(ms) {
    const next = Math.max(0, Math.floor(ms));
    console.log(`[wireless] setMeterRate \u2192 ${next}ms`);
    this.meterRateMs = next;
    await settingsStore.patch({ wirelessMeterRateMs: next });
    deviceManager.setMeterRate(next);
    await deviceManager.stop();
    await deviceManager.applyConnections(this.connections);
    this.broadcast();
    return { ms: next };
  }
  /** Re-apply connections without reloading from disk (use after master toggle). */
  async reapply() {
    console.log("[wireless] reapply");
    await deviceManager.applyConnections(this.connections);
  }
  // ── Public API ─────────────────────────────────────────────────────────
  listProviders() {
    return providerRegistry.getDescriptors();
  }
  listConnections() {
    return this.connections.map((c) => ({ ...c }));
  }
  async addConnection(params) {
    const index = this.connections.length + 1;
    const conn = {
      id: randomUUID2(),
      name: params.name?.trim() || `Connection ${index}`,
      providerId: params.providerId ?? "none",
      enabled: false,
      connection: "disconnected",
      message: null,
      config: {}
    };
    console.log(`[wireless] addConnection \u2014 ${conn.id} (${conn.name}, provider=${conn.providerId})`);
    this.connections.push(conn);
    await this.persist();
    await deviceManager.applyConnections(this.connections);
    this.broadcast();
    return this.listConnections();
  }
  async updateConnection(params) {
    const idx = this.connections.findIndex((c) => c.id === params.id);
    if (idx === -1) throw new Error(`wireless:updateConnection \u2014 unknown id: ${params.id}`);
    const conn = this.connections[idx];
    const patch = params.patch;
    if (patch.name !== void 0) conn.name = patch.name.trim() || conn.name;
    if (patch.providerId !== void 0) conn.providerId = patch.providerId;
    if (patch.enabled !== void 0) conn.enabled = patch.enabled;
    if (patch.config !== void 0) conn.config = { ...conn.config, ...patch.config };
    console.log(`[wireless] updateConnection \u2014 ${conn.id} patch keys: ${Object.keys(patch).join(", ")}`);
    await this.persist();
    await deviceManager.applyConnections(this.connections);
    this.broadcast();
    return this.listConnections();
  }
  async removeConnection(params) {
    const idx = this.connections.findIndex((c) => c.id === params.id);
    if (idx === -1) throw new Error(`wireless:removeConnection \u2014 unknown id: ${params.id}`);
    console.log(`[wireless] removeConnection \u2014 ${params.id}`);
    this.connections.splice(idx, 1);
    await this.persist();
    await deviceManager.applyConnections(this.connections);
    this.broadcast();
    return this.listConnections();
  }
  async testConnection(params) {
    const conn = this.connections.find((c) => c.id === params.id);
    if (!conn) throw new Error(`wireless:testConnection \u2014 unknown id: ${params.id}`);
    if (conn.providerId === "none") {
      return { ok: true, message: "No hardware driver \u2014 placeholder connection" };
    }
    if (!providerRegistry.hasDriver(conn.providerId)) {
      const desc = providerRegistry.getDescriptor(conn.providerId);
      return {
        ok: false,
        message: `${desc?.label ?? conn.providerId}: driver arrives in a future update`
      };
    }
    return {
      ok: true,
      message: `Provider available (state: ${conn.connection ?? "unknown"})`
    };
  }
  // ── Helpers ───────────────────────────────────────────────────────────
  async persist() {
    await wirelessStore.save(
      this.connections.map(({ id, name, providerId, enabled, config }) => ({
        id,
        name,
        providerId,
        enabled,
        config
      }))
    );
  }
  broadcast() {
    ipcMain2.broadcast("wireless:connections-changed", this.listConnections());
  }
};
var wirelessManager = new WirelessManager();

// main/services/integration-manager.ts
var PCO_DESCRIPTOR = {
  id: "planning-center",
  kind: "lineup",
  label: "Planning Center",
  configSchema: [
    {
      key: "appId",
      label: "App ID",
      type: "text",
      placeholder: "your-app-id"
    },
    {
      key: "secret",
      label: "Secret",
      type: "password",
      placeholder: "your-secret"
    }
  ]
};
var WIRELESS_DESCRIPTOR = {
  id: "wireless",
  kind: "wireless",
  label: "Wireless Gear",
  configSchema: []
};
var COMPANION_DESCRIPTOR = {
  id: "companion",
  kind: "control",
  label: "Bitfocus Companion",
  configSchema: [
    {
      key: "host",
      label: "Companion Host",
      type: "text",
      placeholder: "192.168.1.50"
    },
    {
      key: "port",
      label: "Port",
      type: "number",
      placeholder: "8888"
    }
  ]
};
var DESCRIPTORS = [
  PCO_DESCRIPTOR,
  WIRELESS_DESCRIPTOR,
  COMPANION_DESCRIPTOR
];
var SECRET_KEYS = {
  "planning-center": ["secret"],
  wireless: [],
  companion: []
};
var IntegrationManager = class {
  states = /* @__PURE__ */ new Map();
  // ── Init ──────────────────────────────────────────────────────────────
  async init() {
    console.log("[integration-manager] init");
    const settings = await settingsStore.load();
    for (const descriptor of DESCRIPTORS) {
      const savedConfig = settings.integrationConfigs[descriptor.id] ?? {};
      const enabled = settings.integrationEnabled[descriptor.id] ?? false;
      const secrets = await secretsStore.getSecrets(descriptor.id);
      const maskedConfig = { ...savedConfig };
      for (const key of SECRET_KEYS[descriptor.id] ?? []) {
        maskedConfig[key] = secrets[key] ? "\u2022\u2022\u2022\u2022" : "";
      }
      this.states.set(descriptor.id, {
        id: descriptor.id,
        enabled,
        connection: "disconnected",
        message: null,
        config: maskedConfig
      });
    }
    await this.applyPcoCredentials();
    await wirelessManager.init();
    this.refreshWirelessSummary();
    console.log("[integration-manager] init complete", {
      integrations: Array.from(this.states.keys())
    });
  }
  // ── Public API ─────────────────────────────────────────────────────────
  getDescriptors() {
    return DESCRIPTORS;
  }
  getStates() {
    return Array.from(this.states.values());
  }
  async setConfig(id, config) {
    console.log(`[integration-manager] setConfig ${id}`, Object.keys(config));
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown integration: ${id}`);
    const secretKeys = SECRET_KEYS[id] ?? [];
    const nonSecretConfig = {};
    const newSecrets = {};
    for (const [key, value] of Object.entries(config)) {
      if (secretKeys.includes(key)) {
        if (value !== "\u2022\u2022\u2022\u2022" && value !== "") {
          newSecrets[key] = String(value);
        }
      } else {
        nonSecretConfig[key] = value;
      }
    }
    const settings = await settingsStore.load();
    settings.integrationConfigs[id] = {
      ...settings.integrationConfigs[id] ?? {},
      ...nonSecretConfig
    };
    await settingsStore.save(settings);
    if (Object.keys(newSecrets).length > 0) {
      const existing = await secretsStore.getSecrets(id);
      await secretsStore.setSecrets(id, { ...existing, ...newSecrets });
    }
    const allSecrets = await secretsStore.getSecrets(id);
    const maskedConfig = {
      ...settings.integrationConfigs[id] ?? {}
    };
    for (const key of secretKeys) {
      maskedConfig[key] = allSecrets[key] ? "\u2022\u2022\u2022\u2022" : "";
    }
    this.states.set(id, { ...state, config: maskedConfig });
    if (id === "planning-center") {
      await this.applyPcoCredentials();
      const appId = await this.getPcoAppId();
      const secret = await this.getPcoSecret();
      if (appId && secret) {
        try {
          const types = await stageController.listServiceTypes();
          this.setConnectionState(
            "planning-center",
            "connected",
            `Connected \u2014 ${types.length} service type(s)`
          );
          await stageController.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.setConnectionState("planning-center", "error", msg);
        }
      }
    }
    this.broadcastStates();
    return this.states.get(id);
  }
  async setEnabled(id, enabled) {
    console.log(`[integration-manager] setEnabled ${id} \u2192 ${enabled}`);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown integration: ${id}`);
    this.states.set(id, { ...state, enabled });
    const settings = await settingsStore.load();
    settings.integrationEnabled[id] = enabled;
    await settingsStore.save(settings);
    if (id === "wireless") {
      await wirelessManager.reapply();
      this.refreshWirelessSummary();
    }
    if (id === "planning-center" && !enabled) {
      stageController.setPcoCredentials(null, null);
      this.setConnectionState("planning-center", "disconnected", null);
    }
    this.broadcastStates();
    return this.states.get(id);
  }
  async test(id) {
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
        const { pcoService: pcoService2 } = await Promise.resolve().then(() => (init_pco_service(), pco_service_exports));
        const types = await pcoService2.listServiceTypes(appId, secret);
        const msg = `Connected \u2014 found ${types.length} service type(s)`;
        this.setConnectionState("planning-center", "connected", msg);
        this.broadcastStates();
        return { ok: true, message: msg };
      }
      if (id === "wireless") {
        const connections = wirelessManager.listConnections();
        const connected = connections.filter((c) => c.connection === "connected").length;
        return {
          ok: true,
          message: `${connected} of ${connections.length} connection(s) connected`
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
  setConnectionState(id, connection, message) {
    const state = this.states.get(id);
    if (state) {
      this.states.set(id, { ...state, connection, message });
    }
  }
  async getPcoAppId() {
    const settings = await settingsStore.load();
    return String(settings.integrationConfigs["planning-center"]?.appId ?? "") || null;
  }
  async getPcoSecret() {
    const secrets = await secretsStore.getSecrets("planning-center");
    return secrets.secret || null;
  }
  async applyPcoCredentials() {
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
  refreshWirelessSummary() {
    const connections = wirelessManager.listConnections();
    const connected = connections.filter((c) => c.connection === "connected").length;
    if (connected > 0) {
      this.setConnectionState(
        "wireless",
        "connected",
        `${connected} of ${connections.length} connection(s) connected`
      );
    } else {
      this.setConnectionState("wireless", "disconnected", null);
    }
  }
  broadcastStates() {
    ipcMain3.broadcast("integrations:state-changed", this.getStates());
  }
};
var integrationManager = new IntegrationManager();

// main/handlers/integrations.ts
function registerIntegrationHandlers() {
  ipcMain4.handle("integrations:list", async () => {
    return {
      descriptors: integrationManager.getDescriptors(),
      states: integrationManager.getStates()
    };
  });
  ipcMain4.handle(
    "integrations:setConfig",
    async (_event, params) => {
      const { id, config } = params;
      if (typeof id !== "string" || !id) {
        throw new Error("integrations:setConfig \u2014 id (string) required");
      }
      if (typeof config !== "object" || config === null) {
        throw new Error("integrations:setConfig \u2014 config (object) required");
      }
      return integrationManager.setConfig(id, config);
    }
  );
  ipcMain4.handle(
    "integrations:setEnabled",
    async (_event, params) => {
      const { id, enabled } = params;
      if (typeof id !== "string" || !id) {
        throw new Error("integrations:setEnabled \u2014 id (string) required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("integrations:setEnabled \u2014 enabled (boolean) required");
      }
      return integrationManager.setEnabled(id, enabled);
    }
  );
  ipcMain4.handle(
    "integrations:test",
    async (_event, params) => {
      const { id } = params;
      if (typeof id !== "string" || !id) {
        throw new Error("integrations:test \u2014 id (string) required");
      }
      return integrationManager.test(id);
    }
  );
  ipcMain4.handle("wireless:listProviders", async () => {
    return wirelessManager.listProviders();
  });
  ipcMain4.handle("wireless:listConnections", async () => {
    return wirelessManager.listConnections();
  });
  ipcMain4.handle("wireless:addConnection", async (_event, params) => {
    const p = params ?? {};
    const name = typeof p.name === "string" ? p.name : void 0;
    const providerId = typeof p.providerId === "string" ? p.providerId : void 0;
    return wirelessManager.addConnection({ name, providerId });
  });
  ipcMain4.handle("wireless:updateConnection", async (_event, params) => {
    const p = params;
    if (typeof p.id !== "string" || !p.id) {
      throw new Error("wireless:updateConnection \u2014 id (string) required");
    }
    const rawPatch = p.patch ?? {};
    const patch = {};
    if (typeof rawPatch.name === "string") patch.name = rawPatch.name;
    if (typeof rawPatch.providerId === "string") patch.providerId = rawPatch.providerId;
    if (typeof rawPatch.enabled === "boolean") patch.enabled = rawPatch.enabled;
    if (typeof rawPatch.config === "object" && rawPatch.config !== null) {
      patch.config = rawPatch.config;
    }
    return wirelessManager.updateConnection({ id: p.id, patch });
  });
  ipcMain4.handle("wireless:removeConnection", async (_event, params) => {
    const p = params;
    if (typeof p.id !== "string" || !p.id) {
      throw new Error("wireless:removeConnection \u2014 id (string) required");
    }
    return wirelessManager.removeConnection({ id: p.id });
  });
  ipcMain4.handle("wireless:testConnection", async (_event, params) => {
    const p = params;
    if (typeof p.id !== "string" || !p.id) {
      throw new Error("wireless:testConnection \u2014 id (string) required");
    }
    return wirelessManager.testConnection({ id: p.id });
  });
  ipcMain4.handle("wireless:listChannels", async () => {
    return deviceManager.listChannels();
  });
  ipcMain4.handle("wireless:getMeterRate", async () => {
    return { ms: wirelessManager.getMeterRate() };
  });
  ipcMain4.handle("wireless:setMeterRate", async (_event, params) => {
    const p = params;
    if (typeof p.ms !== "number" || !Number.isFinite(p.ms) || p.ms < 0) {
      throw new Error("wireless:setMeterRate \u2014 ms (non-negative number) required");
    }
    return wirelessManager.setMeterRate(p.ms);
  });
}

// main/handlers/stage.ts
init_display_windows();
import { ipcMain as ipcMain5 } from "@glaze/core/backend";

// main/services/remote-server.ts
import * as fs4 from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path4 from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var PORT = 8788;
var __filename = fileURLToPath2(import.meta.url);
var __dirname = path4.dirname(__filename);
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function error(res, message, status = 400) {
  json(res, { error: message }, status);
}
async function readBody(req) {
  return new Promise((resolve2, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve2(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
var RemoteServer = class {
  server = null;
  sockets = /* @__PURE__ */ new Set();
  controlHtmlPath;
  constructor() {
    this.controlHtmlPath = path4.join(__dirname, "..", "control.html");
  }
  getLanUrl() {
    return `http://${getLanIp()}:${PORT}`;
  }
  async start() {
    if (this.server) return;
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const pathname = url.pathname;
      console.log(`[remote-server] ${req.method} ${pathname}`);
      if (req.method === "OPTIONS") {
        cors(res);
        res.writeHead(204);
        res.end();
        return;
      }
      cors(res);
      try {
        await this.handleRequest(req, res, pathname, url, req.method ?? "GET");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[remote-server] handler error ${pathname}:`, msg);
        error(res, msg, 500);
      }
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise((resolve2, reject) => {
      this.server.listen(PORT, "0.0.0.0", () => {
        console.log(`[remote-server] listening on 0.0.0.0:${PORT} (LAN: ${this.getLanUrl()})`);
        resolve2();
      });
      this.server.on("error", reject);
    });
  }
  async stop() {
    console.log("[remote-server] stopping");
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise((resolve2) => {
      if (!this.server) {
        resolve2();
        return;
      }
      this.server.close(() => resolve2());
      this.server = null;
    });
    console.log("[remote-server] stopped");
  }
  async handleRequest(req, res, pathname, _url, method) {
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      try {
        const html = await fs4.readFile(this.controlHtmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("Control page not found");
      }
      return;
    }
    if (method === "GET" && pathname === "/api/health") {
      json(res, { ok: true });
      return;
    }
    if (method === "GET" && pathname === "/api/state") {
      json(res, stageController.getState());
      return;
    }
    if (method === "GET" && pathname === "/api/service-types") {
      const types = await stageController.listServiceTypes();
      json(res, types);
      return;
    }
    if (method === "GET" && pathname === "/api/plans") {
      const serviceTypeId = _url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      const plans = await stageController.listPlans(serviceTypeId);
      json(res, plans);
      return;
    }
    if (method === "POST" && pathname === "/api/service-type") {
      const body = await readBody(req);
      if (typeof body.id !== "string") {
        error(res, "body.id (string) required");
        return;
      }
      const state = await stageController.setServiceType(body.id);
      json(res, state);
      return;
    }
    if (method === "POST" && pathname === "/api/plan") {
      const body = await readBody(req);
      if (typeof body.id !== "string") {
        error(res, "body.id (string) required");
        return;
      }
      const state = await stageController.setPlan(body.id);
      json(res, state);
      return;
    }
    if (method === "POST" && pathname === "/api/plan/next") {
      const state = await stageController.selectNextPlan();
      json(res, state);
      return;
    }
    if (method === "POST" && pathname === "/api/plan/mode") {
      const body = await readBody(req);
      if (body.mode !== "auto" && body.mode !== "manual") {
        error(res, 'body.mode must be "auto" or "manual"');
        return;
      }
      const state = await stageController.setPlanMode(body.mode);
      json(res, state);
      return;
    }
    if (method === "POST" && pathname === "/api/refresh") {
      const state = await stageController.refresh();
      json(res, state);
      return;
    }
    if (method === "POST" && pathname === "/api/slots") {
      const body = await readBody(req);
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const displayId = typeof body.displayId === "string" ? body.displayId : "";
      const state = await stageController.setSlots(displayId, body.slots);
      json(res, state);
      return;
    }
    if (method === "GET" && pathname === "/api/displays") {
      json(res, stageController.getDisplays());
      return;
    }
    if (method === "GET" && pathname === "/api/integrations") {
      json(res, {
        descriptors: integrationManager.getDescriptors(),
        states: integrationManager.getStates()
      });
      return;
    }
    if (method === "GET" && pathname === "/api/integrations/wireless/channels") {
      const channels = await deviceManager.listChannels();
      json(res, channels);
      return;
    }
    if (method === "GET" && pathname === "/api/wireless/providers") {
      json(res, wirelessManager.listProviders());
      return;
    }
    if (method === "GET" && pathname === "/api/wireless/connections") {
      json(res, wirelessManager.listConnections());
      return;
    }
    if (method === "POST" && pathname === "/api/wireless/connections") {
      const body = await readBody(req);
      const name = typeof body.name === "string" ? body.name : void 0;
      const providerId = typeof body.providerId === "string" ? body.providerId : void 0;
      const connections = await wirelessManager.addConnection({ name, providerId });
      json(res, connections, 201);
      return;
    }
    const wirelessConnMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)$/);
    if ((method === "PATCH" || method === "POST") && wirelessConnMatch) {
      const id = wirelessConnMatch[1];
      const body = await readBody(req);
      const rawPatch = body.patch ?? body;
      const patch = {};
      if (typeof rawPatch.name === "string") patch.name = rawPatch.name;
      if (typeof rawPatch.providerId === "string") patch.providerId = rawPatch.providerId;
      if (typeof rawPatch.enabled === "boolean") patch.enabled = rawPatch.enabled;
      if (typeof rawPatch.config === "object" && rawPatch.config !== null) {
        patch.config = rawPatch.config;
      }
      const connections = await wirelessManager.updateConnection({ id, patch });
      json(res, connections);
      return;
    }
    const wirelessConnDeleteMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)$/);
    if (method === "DELETE" && wirelessConnDeleteMatch) {
      const id = wirelessConnDeleteMatch[1];
      const connections = await wirelessManager.removeConnection({ id });
      json(res, connections);
      return;
    }
    const wirelessTestMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)\/test$/);
    if (method === "POST" && wirelessTestMatch) {
      const id = wirelessTestMatch[1];
      const result = await wirelessManager.testConnection({ id });
      json(res, result);
      return;
    }
    const configMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/config$/);
    if (method === "POST" && configMatch) {
      const id = configMatch[1];
      const body = await readBody(req);
      if (typeof body.config !== "object" || body.config === null) {
        error(res, "body.config (object) required");
        return;
      }
      const state = await integrationManager.setConfig(
        id,
        body.config
      );
      json(res, state);
      return;
    }
    const enabledMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/enabled$/);
    if (method === "POST" && enabledMatch) {
      const id = enabledMatch[1];
      const body = await readBody(req);
      if (typeof body.enabled !== "boolean") {
        error(res, "body.enabled (boolean) required");
        return;
      }
      const state = await integrationManager.setEnabled(id, body.enabled);
      json(res, state);
      return;
    }
    const testMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/test$/);
    if (method === "POST" && testMatch) {
      const id = testMatch[1];
      const result = await integrationManager.test(id);
      json(res, result);
      return;
    }
    if (method === "POST" && pathname === "/api/show-qr") {
      const body = await readBody(req);
      if (typeof body.show !== "boolean") {
        error(res, "body.show (boolean) required");
        return;
      }
      const state = await stageController.setShowQr(body.show);
      json(res, state);
      return;
    }
    if (method === "GET" && pathname === "/api/presets") {
      const presets = await stageController.listPresets();
      json(res, presets);
      return;
    }
    if (method === "POST" && pathname === "/api/presets") {
      const body = await readBody(req);
      if (typeof body.name !== "string" || !body.name.trim()) {
        error(res, "body.name (non-empty string) required");
        return;
      }
      const displayIdForPreset = typeof body.displayId === "string" ? body.displayId : "";
      const presets = await stageController.savePreset(displayIdForPreset, body.name.trim());
      json(res, presets);
      return;
    }
    const presetApplyMatch = pathname.match(/^\/api\/presets\/([^/]+)\/apply$/);
    if (method === "POST" && presetApplyMatch) {
      const id = presetApplyMatch[1];
      const body = await readBody(req);
      const displayIdForApply = typeof body.displayId === "string" ? body.displayId : "";
      const state = await stageController.applyPreset(displayIdForApply, id);
      json(res, state);
      return;
    }
    const presetDeleteMatch = pathname.match(/^\/api\/presets\/([^/]+)$/);
    if (method === "DELETE" && presetDeleteMatch) {
      const id = presetDeleteMatch[1];
      const presets = await stageController.deletePreset(id);
      json(res, presets);
      return;
    }
    error(res, `Not found: ${method} ${pathname}`, 404);
  }
};
var remoteServer = new RemoteServer();

// main/handlers/stage.ts
function registerStageHandlers() {
  ipcMain5.handle("stage:getState", async () => {
    return stageController.getState();
  });
  ipcMain5.handle("stage:listServiceTypes", async () => {
    return stageController.listServiceTypes();
  });
  ipcMain5.handle(
    "stage:listPlans",
    async (_event, params) => {
      const { serviceTypeId } = params;
      if (typeof serviceTypeId !== "string" || !serviceTypeId) {
        throw new Error("stage:listPlans \u2014 serviceTypeId (string) required");
      }
      return stageController.listPlans(serviceTypeId);
    }
  );
  ipcMain5.handle(
    "stage:setServiceType",
    async (_event, params) => {
      const { id } = params;
      if (typeof id !== "string" || !id) {
        throw new Error("stage:setServiceType \u2014 id (string) required");
      }
      return stageController.setServiceType(id);
    }
  );
  ipcMain5.handle(
    "stage:setPlan",
    async (_event, params) => {
      const { id } = params;
      if (typeof id !== "string" || !id) {
        throw new Error("stage:setPlan \u2014 id (string) required");
      }
      return stageController.setPlan(id);
    }
  );
  ipcMain5.handle("stage:selectNextPlan", async () => {
    return stageController.selectNextPlan();
  });
  ipcMain5.handle(
    "stage:setPlanMode",
    async (_event, params) => {
      const { mode } = params;
      if (mode !== "auto" && mode !== "manual") {
        throw new Error('stage:setPlanMode \u2014 mode must be "auto" or "manual"');
      }
      return stageController.setPlanMode(mode);
    }
  );
  ipcMain5.handle(
    "stage:setSlots",
    async (_event, params) => {
      const p = params;
      if (!Array.isArray(p?.slots)) {
        throw new Error("stage:setSlots \u2014 slots (array) required");
      }
      return stageController.setSlots(p.displayId ?? "", p.slots);
    }
  );
  ipcMain5.handle("stage:refresh", async () => {
    return stageController.refresh();
  });
  ipcMain5.handle(
    "stage:setAllowedServiceTypes",
    async (_event, params) => {
      const p = params;
      if (!Array.isArray(p?.ids) || !p.ids.every((id) => typeof id === "string")) {
        throw new Error("stage:setAllowedServiceTypes \u2014 ids (string[]) required");
      }
      return stageController.setAllowedServiceTypes(p.ids);
    }
  );
  ipcMain5.handle("stage:getRemoteUrl", async () => {
    return { url: remoteServer.getLanUrl() };
  });
  ipcMain5.handle(
    "stage:setShowQr",
    async (_event, params) => {
      const { show } = params;
      if (typeof show !== "boolean") {
        throw new Error("stage:setShowQr \u2014 show (boolean) required");
      }
      return stageController.setShowQr(show);
    }
  );
  ipcMain5.handle("presets:list", async () => {
    return stageController.listPresets();
  });
  ipcMain5.handle(
    "presets:save",
    async (_event, params) => {
      const p = params;
      if (typeof p?.name !== "string" || !p.name.trim()) {
        throw new Error("presets:save \u2014 name (non-empty string) required");
      }
      return stageController.savePreset(p.displayId ?? "", p.name.trim());
    }
  );
  ipcMain5.handle(
    "presets:apply",
    async (_event, params) => {
      const p = params;
      if (typeof p?.id !== "string" || !p.id) {
        throw new Error("presets:apply \u2014 id (string) required");
      }
      return stageController.applyPreset(p.displayId ?? "", p.id);
    }
  );
  ipcMain5.handle(
    "presets:delete",
    async (_event, params) => {
      const { id } = params;
      if (typeof id !== "string" || !id) {
        throw new Error("presets:delete \u2014 id (string) required");
      }
      return stageController.deletePreset(id);
    }
  );
  ipcMain5.handle(
    "displays:add",
    async (_event, params) => {
      const p = params;
      const name = typeof p?.name === "string" ? p.name : void 0;
      const state = await stageController.addDisplay(name);
      const newDisplay = state.displays[state.displays.length - 1];
      if (newDisplay) {
        openDisplayWindow(newDisplay).catch((err) => {
          console.error(`[displays:add] failed to open window for ${newDisplay.id}:`, err);
        });
      }
      return state;
    }
  );
  ipcMain5.handle(
    "displays:rename",
    async (_event, params) => {
      const p = params;
      if (typeof p?.id !== "string" || !p.id) {
        throw new Error("displays:rename \u2014 id (string) required");
      }
      if (typeof p?.name !== "string" || !p.name.trim()) {
        throw new Error("displays:rename \u2014 name (non-empty string) required");
      }
      return stageController.renameDisplay(p.id, p.name);
    }
  );
  ipcMain5.handle(
    "displays:remove",
    async (_event, params) => {
      const p = params;
      if (typeof p?.id !== "string" || !p.id) {
        throw new Error("displays:remove \u2014 id (string) required");
      }
      const state = await stageController.removeDisplay(p.id);
      const { closeDisplayWindow: closeDisplayWindow2 } = await Promise.resolve().then(() => (init_display_windows(), display_windows_exports));
      closeDisplayWindow2(p.id);
      return state;
    }
  );
  ipcMain5.handle(
    "displays:openWindow",
    async (_event, params) => {
      const p = params;
      if (typeof p?.id !== "string" || !p.id) {
        throw new Error("displays:openWindow \u2014 id (string) required");
      }
      const display = stageController.getDisplays().find((d) => d.id === p.id);
      if (!display) throw new Error(`displays:openWindow \u2014 display ${p.id} not found`);
      await openDisplayWindow(display);
      return { ok: true };
    }
  );
}

// main/windows/settings-window.ts
init_window_paths();
import { BrowserWindow as BrowserWindow2, logger as logger3 } from "@glaze/core/backend";
var settingsWindow = null;
async function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    logger3.debug("settings", "Settings window already exists, showing it");
    settingsWindow.show();
    return;
  }
  logger3.info("settings", "Creating settings window");
  settingsWindow = new BrowserWindow2({
    windowKey: "settings",
    width: 920,
    height: 700,
    minWidth: 800,
    minHeight: 560,
    title: "Settings",
    show: false,
    center: true,
    webPreferences: {
      preload: getPreloadPath()
    }
  });
  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  const url = await getWindowUrl("settings-window.html");
  logger3.info("settings", "Loading settings URL", { url });
  await settingsWindow.loadURL(url);
}
function getSettingsWindow() {
  return settingsWindow;
}

// main/handlers/index.ts
import { ipcMain as ipcMain6, logger as logger4 } from "@glaze/core/backend";
var __filename2 = fileURLToPath3(import.meta.url);
var __dirname2 = path5.dirname(__filename2);
function registerHandlers() {
  logger4.info("handlers", "Registering IPC handlers...");
  ipcMain6.handle("app:getInfo", async (_event) => {
    return await appHandlers.getInfo();
  });
  ipcMain6.handle("app:getProjectPath", async () => {
    return path5.join(__dirname2, "..", "..");
  });
  ipcMain6.handle("window:openSettings", async (_event) => {
    await openSettingsWindow();
  });
  ipcMain6.handle("window:closeSettings", async (_event) => {
    getSettingsWindow()?.close();
  });
  registerStageHandlers();
  registerIntegrationHandlers();
  logger4.info("handlers", "\u2713 IPC handlers registered");
}

// main/index.ts
init_display_windows();

// main/services/photo-cache.ts
import * as crypto from "crypto";
import * as fs5 from "fs/promises";
import * as path6 from "path";
import { app as app3 } from "@glaze/core/backend";
var cacheDir = null;
async function getCacheDir() {
  if (!cacheDir) {
    const userDataPath = await app3.getPath("userData");
    cacheDir = path6.join(userDataPath, "cache", "photos");
    await fs5.mkdir(cacheDir, { recursive: true });
  }
  return cacheDir;
}
function urlToFilename(url) {
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  const match = url.match(/\.(\w{2,5})(?:\?|$)/);
  const ext = match ? `.${match[1]}` : ".jpg";
  return `${hash}${ext}`;
}
async function getPhotoPath(photoUrl) {
  try {
    const dir = await getCacheDir();
    const filename = urlToFilename(photoUrl);
    const filePath = path6.join(dir, filename);
    try {
      await fs5.access(filePath);
      return filePath;
    } catch {
    }
    const response = await fetch(photoUrl);
    if (!response.ok) {
      console.error(`[photo-cache] Failed to fetch ${photoUrl}: ${response.status}`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs5.writeFile(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error("[photo-cache] Error caching photo:", err);
    return null;
  }
}

// main/index.ts
protocol.registerSchemesAsPrivileged([
  {
    scheme: "stage-photo",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);
registerHandlers();
async function openAllDisplayWindows() {
  const displays = stageController.getDisplays();
  logger5.info("main", `\u23F1\uFE0F [COLD_START] Opening ${displays.length} display window(s)`);
  for (const display of displays) {
    try {
      await openDisplayWindow(display);
    } catch (err) {
      logger5.error("main", `Failed to open window for display ${display.id}`, err);
    }
  }
}
async function setupApplicationMenu() {
  await initDevToolsButtonState();
  const menu = Menu.buildFromTemplate([
    {
      label: "App",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings\u2026",
          icon: "gearshape",
          accelerator: "Command+,",
          click: async () => await openSettingsWindow()
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ]);
  Menu.setApplicationMenu(menu);
  logger5.info("main", "Application menu configured with Settings");
}
app4.on("window-all-closed", () => {
});
app4.on("activate", (hasVisibleWindows) => {
  logger5.info("main", "App activate event received", { hasVisibleWindows });
  if (!hasVisibleWindows) {
    openAllDisplayWindows().catch((err) => {
      logger5.error("main", "Failed to re-open display windows on activate", err);
    });
  }
});
app4.on("before-quit", () => {
  logger5.info("main", "App before-quit, cleaning up...");
  closeAllDisplayWindows();
  stageController.stopAutoRefresh();
  remoteServer.stop().catch((err) => logger5.error("main", "remoteServer stop error", err));
  deviceManager.stop().catch((err) => logger5.error("main", "deviceManager stop error", err));
});
var startTime = Date.now();
logger5.info("main", "\u23F1\uFE0F [COLD_START] Waiting for app ready...", {
  timestamp: (/* @__PURE__ */ new Date()).toISOString()
});
app4.whenReady().then(async () => {
  const windowCreateStartTime = Date.now();
  logger5.info("main", "\u23F1\uFE0F [COLD_START] App ready, creating main window", {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    wait_duration_ms: windowCreateStartTime - startTime
  });
  protocol.handle("stage-photo", async (request) => {
    const url = new URL(request.url);
    const photoUrl = url.searchParams.get("u");
    if (!photoUrl) {
      return { statusCode: 400, data: "Missing u param", headers: { "Content-Type": "text/plain" } };
    }
    try {
      const decoded = decodeURIComponent(photoUrl);
      const localPath = await getPhotoPath(decoded);
      if (!localPath) {
        return { statusCode: 404, data: "Photo not found", headers: { "Content-Type": "text/plain" } };
      }
      return { path: localPath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger5.error("main", "stage-photo protocol error", { error: msg });
      return { statusCode: 500, data: msg, headers: { "Content-Type": "text/plain" } };
    }
  });
  await setupApplicationMenu();
  await stageController.init();
  await integrationManager.init();
  stageController.setRemoteUrl(remoteServer.getLanUrl());
  if (stageController.getState().pcoConfigured) {
    try {
      await stageController.refresh();
    } catch (err) {
      logger5.error("main", "Startup stage refresh failed", err);
    }
  }
  stageController.startAutoRefresh();
  await remoteServer.start();
  await deviceManager.start();
  openAllDisplayWindows().then(() => {
    const windowCreateEndTime = Date.now();
    logger5.info("main", "\u23F1\uFE0F [COLD_START] Display windows opened successfully", {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      duration_ms: windowCreateEndTime - windowCreateStartTime
    });
  }).catch((err) => {
    logger5.error("main", "Failed to open display windows", err);
  });
});
//# sourceMappingURL=index.js.map
