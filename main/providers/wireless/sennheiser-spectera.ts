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
import { createSseReader, keepSocketAlive, SSE_MAX_BUFFER, type SseEvent, type SseReader } from "../../services/sse-reader.js";

import type { DeviceChannel, DeviceProvider } from "../../types/devices.js";
import { DeviceProviderBase, blankChannel, type ChannelState } from "./device-provider-base.js";

const DEBUG = !!process.env.SPECTERA_DEBUG;
const DEFAULT_PORT = 443;
const USERNAME = "controlSennheiser"; // fixed per Sennheiser SSCv2 auth
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 3_600_000; // internal ceiling; the service-window scheduler applies the real cap
/**
 * How long the stream may carry nothing before the base station is checked.
 *
 * The stream is receive-only: nothing is written to its socket, so a base
 * station that loses power or network without closing it produces no 'end' and
 * no 'error', ever. Its event cadence when nothing changes is NOT known (no
 * hardware to measure, nothing in the public SSCv2 docs), so silence alone does
 * not mark it offline: a quiet stream gets one request, and only a base station
 * that answers neither is declared gone. Also bounds a stream request that is
 * accepted and never answered, which used to sit at "connecting" for ever.
 */
const STREAM_IDLE_MS = 20_000;
/** How long the check on a quiet stream may take before the box counts as gone. */
const PROBE_TIMEOUT_MS = 10_000;
/** TCP keep-alive on the stream: the slow backstop, see keepSocketAlive. */
const STREAM_KEEPALIVE_MS = 10_000;
// Resource branches we ask the base station to push.
const SUBSCRIBE_PATHS = ["/api/mts/paired/all", "/api/rf/channels", "/api/audio/links"];

/** The host and port connect() dials. Exported because the credential check in
 *  wireless-credentials.ts must agree with it exactly: the API password goes
 *  wherever this says, and a port left unset is 443, not "somewhere else". */
export function specteraTarget(cfg: Record<string, unknown>): { host: string | null; port: number } {
  return {
    host: typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null,
    port: typeof cfg.port === "number" && cfg.port > 0 ? Math.floor(cfg.port) : DEFAULT_PORT,
  };
}

export class SennheiserSpectera extends DeviceProviderBase implements DeviceProvider {
  readonly id = "sennheiser-spectera";
  readonly label = "Sennheiser Spectera";

  private host: string | null = null;
  private port = DEFAULT_PORT;
  private password = "";
  private running = false;

  private req: ReturnType<typeof https.request> | null = null;
  /** The check sent on a quiet stream, while one is in flight. */
  private probe: ReturnType<typeof https.request> | null = null;
  /** When the stream last carried a byte. A check that fails after the stream
   *  has spoken again is stale, not a verdict. */
  private lastByteAt = 0;
  /** Instance fields, not constants, so a test can shorten them. */
  private idleMs = STREAM_IDLE_MS;
  private probeTimeoutMs = PROBE_TIMEOUT_MS;
  private sse: SseReader = newSseReader();
  private sessionUuid: string | null = null;
  private reconnectMs = RECONNECT_BASE_MS;
  private channels = new Map<string, ChannelState>();

  protected logTag(): string {
    return "[spectera]";
  }

  /** The base station as a log line names it: two of them must be told apart. */
  private where(): string {
    return `${scrub(this.host ?? "?")}:${this.port}`;
  }

  // ── DeviceProvider interface ──────────────────────────────────────────────

  async connect(cfg: Record<string, unknown>): Promise<void> {
    const target = specteraTarget(cfg);
    this.host = target.host;
    this.port = target.port;
    this.password = typeof cfg.password === "string" ? cfg.password : "";
    this.forgetFailures();
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
    return [...this.channels.values()].map((s) => ({ id: s.channelId, label: s.name ?? s.channelId, deviceType: s.deviceType }));
  }

  // ── SSE stream lifecycle ────────────────────────────────────────────────────

  private authHeader(): string {
    return "Basic " + Buffer.from(`${USERNAME}:${this.password}`).toString("base64");
  }

  /** Every request this driver makes: the stream, the subscription, the check. */
  private requestOptions(path: string, method: string, headers: Record<string, string | number> = {}): https.RequestOptions {
    return {
      host: this.host ?? undefined,
      port: this.port,
      path,
      method,
      headers: { Authorization: this.authHeader(), ...headers },
      rejectUnauthorized: false, // base station uses a self-signed cert
      agent: false,
    };
  }

  private openStream(): void {
    if (!this.running || !this.host) {
      if (!this.host) this.setState("error");
      return;
    }
    this.setState("connecting");
    this.sse = newSseReader();
    this.sessionUuid = null;

    const req = https.request(
      this.requestOptions("/api/ssc/state/subscriptions", "GET", { Accept: "text/event-stream" }),
      (res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          this.reportFailure(
            "auth",
            `${this.where()} refused the API password (HTTP ${res.statusCode}). ` +
              "Check the password under Wireless Gear, and that API access is enabled on the base station.",
          );
          res.resume();
          // Done with this request: its watchdog would otherwise fire while the
          // retry waits and add a "did not open" line pointing at the network.
          this.abortStream();
          this.setState("error");
          this.scheduleReconnect();
          return;
        }
        if (res.statusCode !== 200) {
          this.reportFailure(`status ${res.statusCode}`, `${this.where()} answered the telemetry stream with HTTP ${res.statusCode}`);
          res.resume();
          this.abortStream();
          this.scheduleReconnect();
          return;
        }
        res.setEncoding("utf8");
        // Raw bytes feed the watchdog, not parsed events: a keep-alive comment
        // or a half-delivered event is still the base station talking.
        res.on("data", (chunk: string) => {
          this.lastByteAt = Date.now();
          this.armStreamWatchdog();
          this.onSse(chunk);
        });
        res.on("end", () => this.onStreamClosed());
        res.on("close", () => this.onStreamClosed());
      },
    );
    this.req = req;
    req.on("error", (err: NodeJS.ErrnoException) => {
      this.reportFailure(`error ${err.code ?? err.message}`, `${this.where()} stream failed: ${scrub(err.message)}`);
      this.onStreamClosed();
    });
    keepSocketAlive(req, STREAM_KEEPALIVE_MS);
    // Armed before the request is answered, so a base station that accepts the
    // connection and never replies is bounded too.
    this.armStreamWatchdog();
    req.end();
  }

  private armStreamWatchdog(): void {
    this.armWatchdog(this.idleMs, () => this.onStreamQuiet());
  }

  /** The stream has carried nothing for `idleMs`. */
  private onStreamQuiet(): void {
    if (!this.running || !this.req) return;
    if (!this.sessionUuid) {
      // Nothing to check against yet: the stream itself never got going.
      this.reportFailure(
        "no answer",
        `${this.where()} did not open the telemetry stream within ${this.idleMs / 1000}s; marking its packs offline`,
      );
      this.onStreamClosed();
      return;
    }
    this.checkBaseStation(this.sessionUuid);
  }

  /**
   * Ask a quiet base station whether it is still there. Any HTTP answer, of
   * any status, proves it is up and the stream is simply quiet; no answer
   * within `probeTimeoutMs` means it is gone. A base station that rebooted
   * answers this but resets the old stream's socket on the next TCP keep-alive.
   */
  private checkBaseStation(uuid: string): void {
    if (!this.host || this.probe) return;
    const stream = this.req;
    const sentAt = Date.now();
    const probe = https.request(
      // `timeout` as an option, not setTimeout() afterwards: the option also
      // covers the TCP connect, which is where a powered-off box behind a
      // router hangs — setTimeout() starts only once the socket has connected.
      { ...this.requestOptions(`/api/ssc/state/subscriptions/${encodeURIComponent(uuid)}`, "GET"), timeout: this.probeTimeoutMs },
      (res) => {
        res.resume();
        if (this.probe !== probe) return;
        this.probe = null;
        if (this.running && this.req === stream) this.armStreamWatchdog();
      },
    );
    this.probe = probe;
    probe.on("timeout", () => probe.destroy(new Error(`no answer within ${this.probeTimeoutMs / 1000}s`)));
    probe.on("error", (err: Error) => {
      if (this.probe !== probe) return;
      this.probe = null;
      if (!this.running || this.req !== stream) return;
      // The stream spoke while the check was out: alive after all. Its bytes
      // re-armed the watchdog, but re-arm here too so a quiet stream is never
      // left with neither a watchdog nor a check.
      if (this.lastByteAt > sentAt) {
        this.armStreamWatchdog();
        return;
      }
      this.reportFailure(
        "silent",
        `${this.where()} sent nothing for ${this.idleMs / 1000}s and did not answer a check (${scrub(err.message)}); ` +
          "marking its packs offline",
      );
      this.onStreamClosed();
    });
    probe.end();
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
    // The watchdog and any check in flight belong to this stream.
    this.stopLinkTimers();
    if (this.probe) {
      const probe = this.probe;
      this.probe = null;
      discardRequest(probe);
    }
    if (this.req) {
      const req = this.req;
      this.req = null;
      discardRequest(req);
    }
  }

  // Parse the text/event-stream: events separated by a blank line; each has
  // optional `event:` and one or more `data:` lines. Framing lives in the shared
  // reader (services/sse-reader.ts).
  private onSse(chunk: string): void {
    this.reportWorking();
    for (const event of this.sse.push(chunk)) this.handleEvent(event);
  }

  private handleEvent(event: SseEvent): void {
    const eventName = event.event ?? "message";
    if (!event.data) return;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
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
      this.requestOptions(`/api/ssc/state/subscriptions/${encodeURIComponent(uuid)}`, "PUT", {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      }),
      (res) => {
        if (DEBUG) console.log(`[spectera] subscribe → status ${res.statusCode}`);
        // A refused subscription leaves the stream open and "connected" with no
        // telemetry on it, which nothing else would ever explain.
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) this.reportWorking("subscribe");
        else {
          this.reportFailure(
            `subscribe ${code}`,
            `${this.where()} refused the telemetry subscription (HTTP ${code}); the stream is open but no readings will arrive`,
            "subscribe",
          );
        }
        res.resume();
      },
    );
    put.on("error", (err: NodeJS.ErrnoException) => {
      this.reportFailure(
        `subscribe ${err.code ?? err.message}`,
        `${this.where()} telemetry subscription failed: ${scrub(err.message)}`,
        "subscribe",
      );
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

    // Runtime remaining, in minutes. Same candidate-path style as everything
    // else in this file, and carrying the same caveat noted at the top: the leaf
    // names are NOT confirmed against hardware. Nothing breaks if none of them
    // land — the field stays null and the widgets draw a dash, which is what
    // Spectera did for runtime before this line existed.
    const lifetime = firstNum(
      readDeep(v, ["battery", "lifetime"]),
      readDeep(v, ["battery", "runtime"]),
      v.batteryLifetime,
      v.bat_lifetime,
    );
    if (lifetime != null && lifetime >= 0) st.batteryMinutes = Math.round(lifetime);

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

/**
 * Hang up on a request this driver no longer wants: the stream, or a check on it.
 *
 * BY NAME — 'error', 'response' and the check's 'timeout' are the ones this file
 * attaches to a request ('response' being the callback passed to
 * https.request()), and 'socket' is keepSocketAlive's. 'error' is the one that matters: on the stream it calls
 * onStreamClosed(), so destroying a request on purpose would otherwise schedule
 * a reconnect for a stream we hung up on. A bare removeAllListeners() would take
 * Node's own listeners with them.
 *
 * The data/end/close handlers live on the RESPONSE, which is a different emitter
 * and was never reachable from here; destroy() below closes it, and
 * onStreamClosed() is idempotent and gated on `running`.
 */
function discardRequest(req: ReturnType<typeof https.request>): void {
  for (const event of ["error", "response", "socket", "timeout"] as const) req.removeAllListeners(event);
  // An 'error' still arrives AFTER the listeners come off, and it arrives
  // asynchronously, so the try/catch below cannot see it: Node's HTTP client
  // manufactures "socket hang up" when a socket closes with a response still
  // outstanding, which is exactly what destroying a half-open SSE request does.
  // With nothing listening that is an uncaughtException, and it takes the whole
  // server down — an operator disabling this integration while it was
  // mid-reconnect was one keystroke from doing it.
  //
  // Absorbed rather than reported: this request was hung up on deliberately,
  // there is no caller left to hand a failure to. Kept on DEBUG so it is still
  // visible when somebody is pinning the schema against a real base station.
  req.on("error", (err: Error) => {
    if (DEBUG) console.log(`[spectera] discarded request error after abort: ${scrub(err.message)}`);
  });
  try {
    req.destroy();
  } catch {
    /* already gone */
  }
}

/**
 * A fresh reader per connection — a partial event does not survive the stream,
 * and carrying one over would splice the tail of the old stream onto the head of
 * the new one.
 *
 * The overflow line is not DEBUG-gated, unlike the raw-event trace.
 * Everything else here is a successful exchange; this one says telemetry was
 * dropped, and the old runaway guard cleared the buffer in total silence, so a
 * base station flooding the stream left nothing at all to read.
 */
function newSseReader(): SseReader {
  return createSseReader({
    onOverflow: () => console.warn(`[spectera] SSE buffer exceeded ${SSE_MAX_BUFFER} chars — resyncing`),
  });
}

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
