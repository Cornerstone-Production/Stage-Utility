// SennheiserSpectera — Sennheiser Spectera wideband ecosystem (base station + SEK
// bodypacks) via Sennheiser Sound Control v2 over HTTPS + Server-Sent-Events.
//
// Transport differs from EW-DX/EW-G4 (which are UDP/45): Spectera's API is REST over
// HTTPS on port 443 with HTTP Basic Auth — username is the fixed `controlSennheiser`,
// the password is set on the base station via its WebUI / LinkDesk (API access is
// disabled until a password exists). Pure-LAN; the base station's cert is typically
// self-signed, so TLS verification is relaxed. Live updates arrive on an SSE stream:
//   GET  /api/ssc/state/subscriptions          → text/event-stream, yields a sessionUUID
//   PUT  /api/ssc/state/subscriptions/{uuid}    → the resource paths we want pushed
//
// ⚠️ The exact leaf property names for battery / RF / audio are NOT confirmed from the
// public v17.0 docs (Swagger is JS-rendered; raw spec 404s). Parsing is therefore
// deliberately tolerant — it probes several plausible keys per field and discovers SEK
// devices dynamically. Run with SPECTERA_DEBUG=1 to log raw events and pin the schema
// against a real base station. `connected` is deprecated in the API in favour of `state`;
// there is no per-device mute in v17.0 (documented limitation).

import { clamp } from "../../services/clamp.js";
import * as https from "node:https";
import { scrub } from "../../services/scrub.js";

import type { DeviceChannel, DeviceProvider } from "../../types/devices.js";
import type { ConfigField } from "../../types/integrations.js";
import { DeviceProviderBase, blankChannel, type ChannelState } from "./device-provider-base.js";

const DEBUG = !!process.env.SPECTERA_DEBUG;
const DEFAULT_PORT = 443;
const USERNAME = "controlSennheiser"; // fixed per Sennheiser SSCv2 auth
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 3_600_000; // internal ceiling; the service-window scheduler applies the real cap
// Resource branches we ask the base station to push.
const SUBSCRIBE_PATHS = ["/api/mts/paired/all", "/api/rf/channels", "/api/audio/links"];

export class SennheiserSpectera extends DeviceProviderBase implements DeviceProvider {
  readonly id = "sennheiser-spectera";
  readonly label = "Sennheiser Spectera";
  readonly configSchema: ConfigField[] = [
    {
      key: "host",
      label: "Base Station IP / Hostname",
      type: "text",
      placeholder: "192.168.1.130",
    },
    {
      key: "port",
      label: "HTTPS Port",
      type: "number",
      placeholder: "443",
    },
    {
      key: "password",
      label: "API Password",
      type: "password",
    },
  ];

  private host: string | null = null;
  private port = DEFAULT_PORT;
  private password = "";
  private running = false;

  private req: ReturnType<typeof https.request> | null = null;
  private sseBuffer = "";
  private sessionUuid: string | null = null;
  private reconnectMs = RECONNECT_BASE_MS;
  private channels = new Map<string, ChannelState>();

  // ── DeviceProvider interface ──────────────────────────────────────────────


  async connect(cfg: Record<string, unknown>): Promise<void> {
    this.host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    this.port = typeof cfg.port === "number" && cfg.port > 0 ? Math.floor(cfg.port) : DEFAULT_PORT;
    this.password = typeof cfg.password === "string" ? cfg.password : "";
    this.running = true;
    this.openStream();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.clearReconnect();
    this.abortStream();
    this.markOffline();
    this.setState("disconnected");
  }

  async listChannels(): Promise<DeviceChannel[]> {
    return [...this.channels.values()].map((s) => ({ id: s.channelId, label: s.name ?? s.channelId }));
  }

  // ── SSE stream lifecycle ────────────────────────────────────────────────────

  private authHeader(): string {
    return "Basic " + Buffer.from(`${USERNAME}:${this.password}`).toString("base64");
  }

  private openStream(): void {
    if (!this.running || !this.host) {
      if (!this.host) this.setState("error");
      return;
    }
    this.setState("connecting");
    this.sseBuffer = "";
    this.sessionUuid = null;

    const req = https.request(
      {
        host: this.host,
        port: this.port,
        path: "/api/ssc/state/subscriptions",
        method: "GET",
        headers: { Authorization: this.authHeader(), Accept: "text/event-stream" },
        rejectUnauthorized: false, // base station uses a self-signed cert
        agent: false,
      },
      (res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          if (DEBUG) console.log(`[spectera] auth failed (${res.statusCode})`);
          res.resume();
          this.setState("error");
          this.scheduleReconnect();
          return;
        }
        if (res.statusCode !== 200) {
          if (DEBUG) console.log(`[spectera] unexpected status ${res.statusCode}`);
          res.resume();
          this.scheduleReconnect();
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => this.onSse(chunk));
        res.on("end", () => this.onStreamClosed());
        res.on("close", () => this.onStreamClosed());
      },
    );
    this.req = req;
    req.on("error", (err) => {
      if (DEBUG) console.log(`[spectera] request error: ${scrub(err.message)}`);
      this.onStreamClosed();
    });
    req.end();
  }

  private onStreamClosed(): void {
    this.abortStream();
    this.markOffline();
    if (this.running) {
      this.setState("error");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectPending) return;
    const raw = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.queueReconnect(raw, () => this.openStream());
  }

  private abortStream(): void {
    if (this.req) {
      this.req.removeAllListeners();
      try {
        this.req.destroy();
      } catch {
        /* already gone */
      }
      this.req = null;
    }
  }

  // Parse the text/event-stream: events separated by a blank line; each has
  // optional `event:` and one or more `data:` lines.
  private onSse(chunk: string): void {
    this.sseBuffer += chunk;
    let sep: number;
    while ((sep = this.sseBuffer.indexOf("\n\n")) >= 0) {
      const raw = this.sseBuffer.slice(0, sep);
      this.sseBuffer = this.sseBuffer.slice(sep + 2);
      this.handleEvent(raw);
    }
    if (this.sseBuffer.length > 256_000) this.sseBuffer = ""; // runaway guard
  }

  private handleEvent(raw: string): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (DEBUG) console.log(`[spectera] ← ${eventName}: ${JSON.stringify(data)}`);

    // First event carries the session id; once we have it, register our subscriptions.
    const uuid = findSessionUuid(data);
    if (uuid && !this.sessionUuid) {
      this.sessionUuid = uuid;
      this.setState("connected");
      this.reconnectMs = RECONNECT_BASE_MS;
      this.sendSubscription(uuid);
      return;
    }
    this.setState("connected");
    this.applyData(data);
  }

  private sendSubscription(uuid: string): void {
    if (!this.host) return;
    const body = JSON.stringify({ subscribe: SUBSCRIBE_PATHS, requested: SUBSCRIBE_PATHS });
    const put = https.request(
      {
        host: this.host,
        port: this.port,
        path: `/api/ssc/state/subscriptions/${encodeURIComponent(uuid)}`,
        method: "PUT",
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        if (DEBUG) console.log(`[spectera] subscribe → status ${res.statusCode}`);
        res.resume();
      },
    );
    put.on("error", (err) => {
      if (DEBUG) console.log(`[spectera] subscribe error: ${scrub(err.message)}`);
    });
    put.write(body);
    put.end();
  }

  // ── Telemetry mapping (tolerant — see file header) ──────────────────────────

  // Data may arrive as {address, value}, or as a nested object keyed by address.
  // Walk it for any paired-device (SEK) entries and update their channel state.
  private applyData(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const obj = data as Record<string, unknown>;

    if (typeof obj.address === "string") {
      this.applyAddress(obj.address, obj.value);
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      this.applyAddress(key, value);
    }
  }

  private applyAddress(address: string, value: unknown): void {
    // Only care about paired mobile devices (SEK) — that's where per-user telemetry lives.
    const m = address.match(/\/api\/mts\/paired\/all\/([^/]+)/);
    if (!m) return;
    const uid = m[1];
    if (uid === "all") {
      // A bulk map of all paired devices.
      if (value && typeof value === "object") {
        for (const [id, v] of Object.entries(value as Record<string, unknown>)) this.updateSek(id, v);
      }
      return;
    }
    this.updateSek(uid, value);
  }

  private updateSek(uid: string, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    // blankChannel, not a literal: the hand-written one here is exactly what had
    // silently lost five fields, and a shared constructor cannot.
    let st = this.channels.get(uid);
    if (!st) {
      st = blankChannel(uid, { name: uid });
      this.channels.set(uid, st);
    }

    const name = firstString(v.name, v.link_name, (v.identity as Record<string, unknown> | undefined)?.name);
    if (name) st.name = name;

    // state: "Connected"/"Disconnected" (preferred) or deprecated `connected` bool.
    const state = firstString(v.state);
    if (state) st.online = state.toLowerCase() === "connected";
    else if (typeof v.connected === "boolean") st.online = v.connected;

    const battery = firstNum(
      readDeep(v, ["battery", "gauge"]),
      v.batteryGauge,
      v.bat_gauge,
      readDeep(v, ["battery", "percent"]),
      typeof v.battery === "number" ? v.battery : undefined,
    );
    if (battery != null) st.battery = battery;

    const rf = firstNum(readDeep(v, ["rf", "quality"]), v.rsqi, v.link_quality, v.rfQuality);
    if (rf != null) st.rfBars = clamp(Math.round((rf / 100) * 5), 0, 5);

    const freq = firstNum(v.frequency, readDeep(v, ["rf", "frequency"]));
    if (freq != null) st.frequencyLabel = `${(freq > 10_000 ? freq / 1000 : freq).toFixed(3)} MHz`;

    const audio = firstNum(readDeep(v, ["audio", "level"]), v.audioLevel, v.level);
    if (audio != null) st.audioLevel = audio;

    // The fields the copy had lost. Names are read defensively, the same way
    // everything else here is: SSCv2 spells these differently across firmware and
    // an absent one simply stays null rather than being reported as a zero.
    // Range-checked, because the candidate keys are not all the same unit. Two
    // lines up, `rsqi` is read as a 0-100 QUALITY figure, and its sibling `rssi`
    // is a 0-100 or 0-255 scalar on plenty of Sennheiser gear — feeding that into
    // a field named dBm renders "+72 dBm", which is physically impossible and
    // strictly worse than the dash it replaced. RF level is always <= 0.
    const rfDbm = firstNum(readDeep(v, ["rf", "level"]), v.rfLevel, v.rssi, v.rfLevelDbm);
    if (rfDbm != null && rfDbm <= 0 && rfDbm > -200) st.rfLevelDbm = rfDbm;

    const charging = firstBool(
      readDeep(v, ["battery", "charging"]),
      v.charging,
      v.isCharging,
      readDeep(v, ["battery", "isCharging"]),
    );
    if (charging != null) st.charging = charging;

    const cycles = firstNum(readDeep(v, ["battery", "cycles"]), v.cycles, v.chargeCycles);
    if (cycles != null) st.cycles = cycles;

    const health = firstNum(readDeep(v, ["battery", "health"]), v.health, v.batteryHealth);
    if (health != null && health >= 0 && health <= 100) st.health = health;

    // Likewise: firmware that reports Kelvin or Fahrenheit would render under a
    // degrees-C label with nothing to signal it is wrong.
    const tempC = firstNum(readDeep(v, ["battery", "temperature"]), v.temperature, v.tempC);
    if (tempC != null && tempC > -40 && tempC < 100) st.tempC = tempC;

    this.emitStatus(st);
  }

  private markOffline(): void {
    this.offlineAll(this.channels.values());
  }

}

// ── helpers ───────────────────────────────────────────────────────────────────

function findSessionUuid(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const direct = firstString(o.sessionUUID, o.session, o.sessionId, readDeep(o, ["#", "sessionUUID"]));
  return direct ?? null;
}

function readDeep(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return null;
}

/** First usable boolean, tolerating the string forms SSCv2 sometimes sends. */
function firstBool(...vals: unknown[]): boolean | null {
  for (const v of vals) {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "yes" || s === "charging") return true;
      if (s === "false" || s === "no" || s === "idle") return false;
    }
  }
  return null;
}

function firstNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
