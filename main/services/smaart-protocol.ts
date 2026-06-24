// smaart-protocol.ts — Smaart API wire protocol (JSON-over-WebSocket).
//
// The "modern" Smaart API is a JSON request/response protocol over WebSocket,
// enabled in Smaart via Options → Preferences → API (default port 26000). SDK V3
// covers Smaart 8.3–9.0.1 and V4 covers 9.5+ — they share one object model; only
// the `/api/vN/` path differs, which we negotiate on connect. (Legacy V1, Smaart
// 7.2–8.2, is a different binary C-SDK protocol and is intentionally NOT handled
// here — `SmaartAdapter` leaves room for a future LegacySmaartAdapter behind the
// same interface.)
//
// Shapes below are taken from the Smaart API SDK docs (V3/V4):
//   Root  GET /api/vN/         → { response: { applicationName, applicationVersion,
//                                              authenticationRequired, ... } }
//   Auth  SET { password }
//   GET target:"activeCalibratedInputs" →
//        { response: { devices: [ { deviceName,
//            activeCalibratedChannels: [ { channelIndex, channelName,
//                                          streamEndpoint, logEndpointPrefix } ] } ] } }
//   SPL stream WS @ streamEndpoint pushes, up to 8 fps (throttle via SET targetFPS):
//        { timestamp, deviceName, channelName,
//          metrics: [ {"SPL Fast":74.78}, {"SPL A Slow":75.86}, {"LAeq 10":74.9}, ... ] }
//
// Node 24+ has a global WebSocket (used here) so there is no runtime dependency.

/** Flattened SPL metric values keyed exactly as Smaart names them. */
export interface SplMetrics {
  [metricKey: string]: number;
}

/** One push from an SPL Metric Stream. */
export interface SplReading {
  deviceName: string;
  channelName: string;
  metrics: SplMetrics;
  timestamp: string | null;
}

/** A calibrated, actively-logging input (a selectable "meter"). */
export interface SmaartInput {
  deviceName: string;
  channelName: string;
  channelIndex: number;
  /** Server-provided WS path for this channel's SPL stream (e.g. /api/v3/devices/…/channels/…). */
  streamEndpoint: string;
}

export interface SmaartServerInfo {
  applicationName: string | null;
  applicationVersion: string | null;
  authenticationRequired: boolean;
}

export interface SmaartAdapter {
  /** API version actually negotiated ("3", "4", …). */
  readonly apiVersion: string;
  readonly serverInfo: SmaartServerInfo | null;
  /** Open the control connection, negotiate version, authenticate if required. */
  connect(opts: { password?: string | null }): Promise<void>;
  /** Query the list of calibrated inputs (meters). */
  listInputs(): Promise<SmaartInput[]>;
  /** Open an SPL stream for one input. Returns a closer. */
  openSplStream(
    input: SmaartInput,
    targetFPS: number,
    onReading: (r: SplReading) => void,
    onClose: () => void,
  ): () => void;
  /** Tear down the control connection (and is a no-op if already closed). */
  close(): void;
}

const CONNECT_TIMEOUT_MS = 6000;
const REQUEST_TIMEOUT_MS = 5000;
/** Version paths to probe, newest first. Config may pin one to skip probing. */
const DEFAULT_VERSION_PATHS = ["/api/v4/", "/api/v3/", "/api/v2/"];

interface Pending {
  seq: number;
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Flatten Smaart's `metrics: [{k:v}, …]` into `{ k: v }`, keeping finite numbers. */
function flattenMetrics(raw: unknown): SplMetrics {
  const out: SplMetrics = {};
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        const n = num(v);
        if (n !== null) out[k] = n;
      }
    }
  }
  return out;
}

export class ModernSmaartAdapter implements SmaartAdapter {
  apiVersion = "";
  serverInfo: SmaartServerInfo | null = null;

  private control: WebSocket | null = null;
  private seq = 1;
  private pending: Pending[] = [];

  constructor(
    private readonly host: string,
    private readonly port: number,
    /** Pin a specific version path (e.g. "/api/v3/") to skip probing. */
    private readonly preferredPath?: string | null,
  ) {}

  private wsUrl(pathOrEndpoint: string): string {
    // streamEndpoint values are absolute paths beginning with "/".
    const p = pathOrEndpoint.startsWith("/") ? pathOrEndpoint : `/${pathOrEndpoint}`;
    return `ws://${this.host}:${this.port}${p}`;
  }

  async connect(opts: { password?: string | null }): Promise<void> {
    const candidates = this.preferredPath ? [this.preferredPath] : DEFAULT_VERSION_PATHS;
    let lastErr: Error | null = null;
    for (const path of candidates) {
      try {
        await this.openControl(path);
        // Probe the Root object — proves the version and reports auth state.
        const info = await this.request("get", undefined, undefined);
        const resp = (info.response ?? info) as Record<string, unknown>;
        this.serverInfo = {
          applicationName: str(resp.applicationName),
          applicationVersion: str(resp.applicationVersion),
          authenticationRequired: resp.authenticationRequired === true,
        };
        this.apiVersion = path.replace(/\D/g, "") || "?";
        if (this.serverInfo.authenticationRequired) {
          const password = opts.password ?? "";
          await this.request("set", undefined, [{ password }]);
        }
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        this.teardownControl();
      }
    }
    throw lastErr ?? new Error("Could not connect to the Smaart API");
  }

  private openControl(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl(path));
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection to ${path} timed out`));
      }, CONNECT_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.control = ws;
        resolve();
      });
      ws.addEventListener("message", (ev) => this.onControlMessage(ev));
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to ${path}`));
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        // Fail any in-flight requests so callers don't hang.
        for (const p of this.pending.splice(0)) {
          clearTimeout(p.timer);
          p.reject(new Error("Smaart control connection closed"));
        }
        if (this.control === ws) this.control = null;
      });
    });
  }

  private onControlMessage(ev: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    // Prefer correlating by sequenceNumber; fall back to FIFO (the server does
    // not always echo it, and we keep request volume low + serialized).
    const echoed = num(msg.sequenceNumber);
    let idx = echoed != null ? this.pending.findIndex((p) => p.seq === echoed) : -1;
    if (idx === -1 && this.pending.length) idx = 0;
    if (idx === -1) return;
    const [p] = this.pending.splice(idx, 1);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  private request(
    action: "get" | "set",
    target: string | undefined,
    properties: Record<string, unknown>[] | undefined,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.control || this.control.readyState !== WebSocket.OPEN) {
        reject(new Error("Smaart control connection not open"));
        return;
      }
      const seq = this.seq++;
      const body: Record<string, unknown> = { sequenceNumber: seq, action };
      if (target !== undefined) body.target = target;
      if (properties !== undefined) body.properties = properties;
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.seq === seq);
        if (i !== -1) this.pending.splice(i, 1);
        reject(new Error(`Smaart request "${action}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.push({ seq, resolve, reject, timer });
      try {
        this.control.send(JSON.stringify(body));
      } catch (err) {
        clearTimeout(timer);
        this.pending.pop();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async listInputs(): Promise<SmaartInput[]> {
    const msg = await this.request("get", "activeCalibratedInputs", undefined);
    const resp = (msg.response ?? msg) as Record<string, unknown>;
    const devices = Array.isArray(resp.devices) ? resp.devices : [];
    const inputs: SmaartInput[] = [];
    for (const d of devices) {
      const deviceName = str((d as Record<string, unknown>)?.deviceName) ?? "";
      const channels = (d as Record<string, unknown>)?.activeCalibratedChannels;
      if (!Array.isArray(channels)) continue;
      for (const c of channels) {
        const cc = c as Record<string, unknown>;
        const streamEndpoint = str(cc.streamEndpoint);
        if (!streamEndpoint) continue;
        inputs.push({
          deviceName,
          channelName: str(cc.channelName) ?? "",
          channelIndex: num(cc.channelIndex) ?? -1,
          streamEndpoint,
        });
      }
    }
    return inputs;
  }

  openSplStream(
    input: SmaartInput,
    targetFPS: number,
    onReading: (r: SplReading) => void,
    onClose: () => void,
  ): () => void {
    let ws: WebSocket | null = new WebSocket(this.wsUrl(input.streamEndpoint));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onClose();
    };
    ws.addEventListener("open", () => {
      // Streams start at 8 fps (the max); throttle to the requested rate.
      const fps = Math.max(1, Math.min(8, Math.floor(targetFPS)));
      if (fps < 8) {
        try {
          ws?.send(JSON.stringify({ action: "set", properties: [{ targetFPS: fps }] }));
        } catch {
          /* the next reading still arrives at 8 fps — non-fatal */
        }
      }
    });
    ws.addEventListener("message", (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg.metrics)) return; // ignore the set-targetFPS ack
      onReading({
        deviceName: str(msg.deviceName) ?? input.deviceName,
        channelName: str(msg.channelName) ?? input.channelName,
        metrics: flattenMetrics(msg.metrics),
        timestamp: str(msg.timestamp),
      });
    });
    ws.addEventListener("error", () => finish());
    ws.addEventListener("close", () => finish());
    return () => {
      const w = ws;
      ws = null;
      finish();
      try {
        w?.close();
      } catch {
        /* ignore */
      }
    };
  }

  private teardownControl(): void {
    const ws = this.control;
    this.control = null;
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(new Error("Smaart control connection closed"));
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }

  close(): void {
    this.teardownControl();
  }
}
