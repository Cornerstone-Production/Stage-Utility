// LAN HTTP server on port 8788.
// Serves public/control.html at GET / and the /api/* endpoints.
// Permissive CORS on /api/*. Tracks sockets for clean shutdown.


import * as fs from "fs/promises";
import { scrub } from "./scrub.js";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "url";



import { addBroadcastListener, setSubscriberCheck } from "./broadcaster.js";
import { execFileSync } from "node:child_process";

import { APP_ROOT } from "./app-root.js";
import { displayHeartbeat, displayLeaving, presenceSnapshot } from "./display-presence.js";
import { buildHistoryWorkbook, historyFileName, type HistorySheet } from "./history-export.js";
import { getLogLines } from "./log-buffer.js";

import { saveLayoutImage, readLayoutImage } from "./layout-image-store.js";
import { BRANDING_IMAGE_DIR } from "./branding-image-store.js";
import { readImage } from "./image-files.js";
import { integrationManager } from "./integration-manager.js";
import { obsService } from "./obs-service.js";
import { reaperService } from "./reaper-service.js";
import { oscManager } from "./osc-manager.js";
import { propresenterService, propresenterManager } from "./propresenter-service.js";
import { sensourceService } from "./sensource-service.js";
import { smaartService } from "./smaart-service.js";
import { splRecorder } from "./spl-recorder.js";
import { attendanceRecorder } from "./attendance-recorder.js";
import { serviceTimelineRecorder } from "./service-timeline-recorder.js";
import { baptismTimerService } from "./baptism-timer-service.js";
import { stageController } from "./stage-controller.js";
import { updater } from "./updater.js";
import { SERVER_VERSION } from "./server-version.js";

import { type RouteCtx, json, error, readBody } from "./routes/context.js";
import { statusRoutes } from "./routes/status-routes.js";
import { historyRoutes } from "./routes/history-routes.js";
import { archiveRoutes } from "./routes/archive-routes.js";
import { proxyRoutes } from "./routes/proxy-routes.js";
import { stateRoutes } from "./routes/state-routes.js";
import { scriptviewRoutes } from "./routes/scriptview-routes.js";
import { viewRoutes } from "./routes/view-routes.js";
import { integrationRoutes } from "./routes/integration-routes.js";
import { rosstalkRoutes } from "./routes/rosstalk-routes.js";
import { automationRoutes } from "./routes/automation-routes.js";
import { displaySettingsRoutes } from "./routes/display-settings-routes.js";
import { systemRoutes } from "./routes/system-routes.js";
import { brandingRoutes } from "./routes/branding-routes.js";
import { presetRoutes } from "./routes/preset-routes.js";

// ── Static renderer build path candidates ──────────────────────────────────────
// Resolved against the install root, NOT the working directory. A packaged
// install is launched from wherever the operator happens to be — `brew install`
// then running the binary from the home directory looked for
// ~/build/renderer, found nothing, and served "Control page not found" while
// the files sat correctly in libexec/build/renderer.
const RENDERER_BUILD_DIR = path.join(APP_ROOT, "build", "renderer");

const PORT = Number(process.env.STAGE_UTILITY_PORT) || 8788;
// "Friendly" port so operators can browse without typing the port. We bind it in
// ADDITION to PORT (8788 always stays up for Companion + existing links). Default
// 80; set STAGE_UTILITY_FRIENDLY_PORT=0 to disable. Binding is best-effort — if the
// process lacks privilege (non-root, no CAP_NET_BIND_SERVICE) or the port is taken,
// we log and keep serving PORT rather than failing to start.
const FRIENDLY_PORT = process.env.STAGE_UTILITY_FRIENDLY_PORT !== undefined
  ? Number(process.env.STAGE_UTILITY_FRIENDLY_PORT)
  : 80;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getLanIp(): string {
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

function cors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** Hostname of an Origin header ("http://host:port") or a Host header ("host:port"). */
function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a request is a browser cross-site request. Pure + exported so the
 * matrix below can be unit-tested without a socket.
 *
 * The app is deliberately unauthenticated: it's a LAN appliance, and displays,
 * phones and the Companion module all reach it without credentials. That is fine
 * for peers on the network — but a browser is a confused deputy. Any page an
 * operator visits can POST here, and with permissive CORS the preflight passes,
 * so a drive-by page could hit POST /api/update/apply and rebuild + restart every
 * display mid-service. DNS rebinding makes that reachable from the open internet.
 *
 * No Origin header  → not a browser cross-site request (Companion, curl, a
 *                     script, or a same-origin navigation). Allowed.
 * Origin present    → its hostname must match the Host it was sent to.
 * Origin: "null"    → a sandboxed iframe or opaque origin. Rejected.
 *
 * Ports are ignored so the Vite dev proxy (:3000 → :8788) keeps working. The
 * check rests on hostname, which an attacker cannot serve the appliance's own
 * address from.
 */
export function isCrossOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  const from = hostnameOf(origin);
  const to = hostnameOf(host);
  return from === null || to === null || from !== to;
}

/** Methods that change server state, and so must be same-origin. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Self-contained /log viewer page — polls /api/log every 2s, filter + autoscroll.
 *  No framework/build; served directly so it works even if the renderer bundle is
 *  missing. Carries any ?token through to its fetches. */
function renderLogPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stage Utility — Server log</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0c0e;color:#d6d9de}
header{position:sticky;top:0;display:flex;gap:.75rem;align-items:center;padding:.6rem .8rem;background:#121418;border-bottom:1px solid #23262c}
header h1{font:600 14px system-ui;margin:0;color:#e8ebef}.sp{flex:1}
input,button{font:inherit;background:#1a1d22;color:#d6d9de;border:1px solid #2a2e35;border-radius:6px;padding:.3rem .5rem}button{cursor:pointer}
#log{padding:.5rem .8rem;white-space:pre-wrap;word-break:break-word}.ln{padding:.5px 0}.t{color:#6b7280}.warn{color:#f5c451}.error{color:#f2777a}.muted{color:#6b7280}
</style></head><body>
<header><h1>Server log</h1><span class="muted" id="count"></span><span class="sp"></span>
<input id="filter" placeholder="filter…" autocomplete="off"><label class="muted"><input type="checkbox" id="auto" checked> auto</label><button id="refresh">refresh</button></header>
<div id="log"></div>
<script>
var token=new URLSearchParams(location.search).get('token');var q=token?('?token='+encodeURIComponent(token)):'';
var logEl=document.getElementById('log'),filterEl=document.getElementById('filter'),autoEl=document.getElementById('auto'),countEl=document.getElementById('count');var lines=[];
function esc(s){return String(s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
/* Lines are stamped as UTC ISO. Slicing characters 11-19 out of that string
   printed UTC verbatim, so an operator west of Greenwich read timestamps hours
   adrift from the wall clock they were comparing against. Parse and format
   instead, which renders in the VIEWER's zone - this page is served to whoever
   opens it, so the browser's zone is the right one, not the server's. */
function fmtT(iso){var d=new Date(iso);if(isNaN(d.getTime()))return esc(iso).slice(11,19);
return d.toLocaleTimeString(undefined,{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function render(){var f=filterEl.value.toLowerCase();var atBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-40);
var shown=lines.filter(function(l){return !f||l.msg.toLowerCase().indexOf(f)>=0||l.level.indexOf(f)>=0});
countEl.textContent=shown.length+' / '+lines.length+' lines';
logEl.innerHTML=shown.map(function(l){return '<div class="ln '+l.level+'"><span class="t">'+fmtT(l.t)+'</span> '+esc(l.msg)+'</div>'}).join('');
if(autoEl.checked&&atBottom)window.scrollTo(0,document.body.scrollHeight)}
function load(){fetch('/api/log'+q).then(function(r){return r.json()}).then(function(d){lines=d.lines||[];render()}).catch(function(){})}
filterEl.oninput=render;document.getElementById('refresh').onclick=load;load();setInterval(function(){if(autoEl.checked)load()},2000);
</script></body></html>`;
}

// SSE client set — each entry is the ServerResponse for an open /api/events stream.
const sseClients = new Set<http.ServerResponse>();
// Keep the SSE pipe warm and surface dead clients: EventSource ignores comment
// lines, but the write itself fails (or backs up) on a half-open socket so we can
// reap it. Without this, a slept/dropped kiosk lingers forever holding memory and
// one of the browser's ~6 HTTP/1.1 connection slots.
const SSE_HEARTBEAT_MS = 20_000;
// If a client's un-flushed write buffer grows past this, it's stalled (asleep, wifi
// gone). Drop it rather than let its backlog grow server memory without bound — the
// broadcast loop has no backpressure otherwise.
const SSE_MAX_BUFFER_BYTES = 2_000_000;
// Per-connection channel filter. A client reports the exact channel set it renders
// (POST /api/events/subscribe, keyed by its cid); the fan-out then skips channels a
// client didn't ask for — so a mic display never receives the 4 Hz spl:metrics
// firehose it discards anyway. Absent entry = no report yet → send everything (safe
// fallback; filtering is a pure optimization, never a correctness dependency).
const resCid = new WeakMap<http.ServerResponse, string>();
const clientChannels = new Map<string, Set<string>>();

// Currently-connected Companion-module clients (SSE streams opened with the
// X-Companion-Module header / ?client=companion marker). A Set keyed by the
// response means the reported count can't drift (no double-count on a fast
// reconnect, no under-count if a close fires twice) — `.size` is always exact.
// Pushed into the integration manager so the "companion" panel shows "N connected".
const companionClients = new Set<http.ServerResponse>();

/** Write one SSE event. Returns false when the client is gone or so far behind
 *  (buffered bytes over the cap) that it should be dropped — callers remove + destroy
 *  it. This is the only backpressure guard on the fan-out, so a slow/dead client
 *  can't buffer unboundedly in server memory. */
function sseHealthy(res: http.ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed && res.writableLength <= SSE_MAX_BUFFER_BYTES;
}
/** Write a pre-built SSE frame; returns false if the client is gone or backed up. */
function sseWriteFrame(res: http.ServerResponse, frame: string): boolean {
  if (!sseHealthy(res)) return false;
  try {
    res.write(frame);
    return true;
  } catch {
    return false;
  }
}
function sseWrite(res: http.ServerResponse, event: string, data: unknown): boolean {
  return sseWriteFrame(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// gzip for static text assets — a Pi re-downloads the whole (re-fingerprinted) build
// on each deploy, and ~736 KB of JS/CSS/HTML collapses to ~217 KB. Immutable
// /assets/* are content-hashed, so compress once and cache the bytes forever.
// Per-request logging is off unless STAGE_UTILITY_DEBUG=1 — it's one line per HTTP
// request and the launchd/systemd stdout log is often unrotated (grows until reboot).
const DEBUG_HTTP = process.env.STAGE_UTILITY_DEBUG === "1";
// Optional token gate for the /log viewer. The app has no auth (LAN-trusted), so
// /log is open by default like everything else; set STAGE_UTILITY_LOG_TOKEN to
// require ?token=… on /log + /api/log (logs can carry internal detail).
const LOG_TOKEN = process.env.STAGE_UTILITY_LOG_TOKEN || null;
function logAuthed(url: URL): boolean {
  return !LOG_TOKEN || url.searchParams.get("token") === LOG_TOKEN;
}
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".webmanifest"]);
const gzipCache = new Map<string, Buffer>();
function acceptsGzip(acceptEncoding: string | undefined): boolean {
  return typeof acceptEncoding === "string" && /\bgzip\b/.test(acceptEncoding);
}
function sendStatic(
  res: http.ServerResponse,
  data: Buffer,
  mime: string,
  cacheControl: string,
  ext: string,
  acceptEncoding: string | undefined,
  cacheKey: string | null, // non-null → immutable, cache the gzipped bytes
): void {
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Cache-Control": cacheControl,
    Vary: "Accept-Encoding",
  };
  if (COMPRESSIBLE.has(ext) && data.length > 1024 && acceptsGzip(acceptEncoding)) {
    let gz = cacheKey ? gzipCache.get(cacheKey) : undefined;
    if (!gz) {
      gz = zlib.gzipSync(data);
      if (cacheKey) gzipCache.set(cacheKey, gz);
    }
    headers["Content-Encoding"] = "gzip";
    res.writeHead(200, headers);
    res.end(gz);
  } else {
    res.writeHead(200, headers);
    res.end(data);
  }
}

export class RemoteServer {
  private server: http.Server | null = null;
  private friendlyServer: http.Server | null = null;
  private friendlyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private sockets = new Set<net.Socket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Resolve control.html with a multi-candidate fallback so it works whether
    // run from a build output dir or directly via tsx.
    this._controlHtmlCandidates = [
      path.join(__dirname, "..", "control.html"),           // build output
      path.join(__dirname, "..", "..", "control.html"),     // tsx dev
      path.join(APP_ROOT, "control.html"),                  // install root
      path.join(APP_ROOT, "public", "control.html"),        // public/
    ];
  }

  private _controlHtmlCandidates: string[] = [];

  /** Try to serve a file from the Vite renderer build. Returns true if handled. */
  private async tryServeStatic(pathname: string, res: http.ServerResponse, acceptEncoding?: string): Promise<boolean> {
    // Clean-URL entry points → built HTML files:
    //   /                     → kiosk (index.html)
    //   /settings             → settings panel (settings-window.html)
    //   /display-1, /foo, …   → fall through to the SPA fallback (kiosk)
    let urlPath: string;
    if (pathname === "/" || pathname === "/index.html") {
      urlPath = "/index.html";
    } else if (pathname === "/settings" || pathname === "/settings/") {
      urlPath = "/settings-window.html";
    } else {
      urlPath = pathname;
    }
    const candidate = path.join(RENDERER_BUILD_DIR, urlPath.replace(/^\//, ""));

    try {
      await fs.access(candidate);
      const ext = path.extname(candidate).toLowerCase();
      const mime =
        ext === ".html" ? "text/html; charset=utf-8" :
        ext === ".js"   ? "application/javascript" :
        ext === ".mjs"  ? "application/javascript" :
        ext === ".css"  ? "text/css" :
        ext === ".svg"  ? "image/svg+xml" :
        ext === ".png"  ? "image/png" :
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
        ext === ".ico"  ? "image/x-icon" :
        ext === ".woff2" ? "font/woff2" :
        // Browsers ignore a web app manifest served as octet-stream, which drops
        // the Add-to-Home-Screen icon on Android/Chrome.
        ext === ".webmanifest" ? "application/manifest+json" :
        ext === ".json" ? "application/json" :
        "application/octet-stream";
      const data = await fs.readFile(candidate);
      // Vite fingerprints everything under /assets/, so cache those forever;
      // everything else (HTML, manifest, icons) must revalidate so a new build is
      // picked up immediately instead of Safari serving a stale page.
      const immutable = urlPath.startsWith("/assets/");
      const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
      // Stamp the served HTML with the version it was built at, so an installed
      // PWA can tell its cached shell is stale vs. the live server and self-reload
      // (see useStageState). Content-hashed /assets are never rewritten.
      let out = data;
      if (ext === ".html") {
        out = Buffer.from(
          data.toString("utf-8").replace("</head>", `<script>window.__APP_VERSION__=${JSON.stringify(SERVER_VERSION)}</script></head>`),
          "utf-8",
        );
      }
      sendStatic(res, out, mime, cacheControl, ext, acceptEncoding, immutable ? candidate : null);
      return true;
    } catch {
      // File not found — fall through
    }

    // SPA fallback: for HTML-like routes (no extension), serve index.html
    if (!path.extname(urlPath)) {
      const fallback = path.join(RENDERER_BUILD_DIR, "index.html");
      try {
        const html = await fs.readFile(fallback);
        sendStatic(res, html, "text/html; charset=utf-8", "no-cache", ".html", acceptEncoding, null);
        return true;
      } catch {
        // No renderer build — fall through to legacy control page
      }
    }

    return false;
  }

  private async resolveControlHtml(): Promise<string | null> {
    for (const candidate of this._controlHtmlCandidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
    return null;
  }

  getLanUrl(): string {
    return `http://${getLanIp()}:${PORT}`;
  }

  /**
   * Best-effort "who is holding this port", for the log only.
   *
   * Fixed argument vectors, no shell, no interpolation of anything a request can
   * reach — the port is a number this process chose. Any failure is silent: this
   * runs while something has already gone wrong, and it must not become a second
   * problem.
   */
  private portHolder(): string {
    const probes: [string, string[]][] =
      process.platform === "win32"
        ? [["netstat", ["-ano", "-p", "TCP"]]]
        : [
            ["lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"]],
            ["ss", ["-lptn", `sport = :${PORT}`]],
          ];
    for (const [cmd, args] of probes) {
      try {
        const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
        const line = out.split("\n").find((l: string) => l.includes(String(PORT)));
        if (line?.trim()) return line.trim();
      } catch {
        // Tool missing or nothing listening — try the next one.
      }
    }
    return "could not determine which process holds it";
  }

  /**
   * Bind the main port, tolerating a previous instance that has not let go yet.
   *
   * This used to reject straight into an unhandled rejection, which exited with a
   * bare EADDRINUSE stack trace. Under `Restart=always` that becomes an
   * unrecoverable loop: systemd relaunches, the port is still held, it dies
   * again, forever — and the log shows a stack trace rather than the one fact
   * that resolves it, which is WHICH process holds the port.
   *
   * The friendly port (80) has always retried for exactly this reason. The main
   * port now does too, and says what is in the way.
   */
  private async listenWithRetry(): Promise<void> {
    const RETRY_MS = 2000;
    const GIVE_UP_AFTER_MS = 60_000;
    const started = Date.now();

    for (;;) {
      try {
        await new Promise<void>((resolve, reject) => {
          // Both handlers are removed on either outcome. Passing the success
          // callback to listen() instead left one registered per failed attempt,
          // and every one of them fired once the port finally freed - three
          // retries produced three "listening" lines for a single bind.
          const onListening = () => {
            this.server!.removeListener("error", onError);
            console.log(`[remote-server] listening on 0.0.0.0:${PORT} (LAN: ${this.getLanUrl()})`);
            resolve();
          };
          const onError = (err: NodeJS.ErrnoException) => {
            this.server!.removeListener("listening", onListening);
            reject(err);
          };
          this.server!.once("listening", onListening);
          this.server!.once("error", onError);
          this.server!.listen(PORT, "0.0.0.0");
        });
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EADDRINUSE") throw err;

        const waited = Date.now() - started;
        if (waited >= GIVE_UP_AFTER_MS) {
          console.error(
            `[remote-server] port ${PORT} is still held after ${Math.round(waited / 1000)}s. ` +
              `Holder: ${this.portHolder()}. ` +
              `Stop that process (kill its pid, or: sudo fuser -k ${PORT}/tcp) and start the service again.`,
          );
          throw err;
        }
        console.warn(
          `[remote-server] port ${PORT} in use, retrying in ${RETRY_MS / 1000}s ` +
            `(${Math.round(waited / 1000)}s so far). Holder: ${this.portHolder()}`,
        );
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }

  async start(): Promise<void> {
    if (this.server) return;

    // Push state to SSE clients on every broadcast so the phone page can use
    // EventSource instead of polling.
    // Let producers idle when nothing is watching their channel: true if any client
    // is subscribed to it, or any client hasn't reported a filter yet (wants all).
    setSubscriberCheck((channel) => {
      for (const client of sseClients) {
        const cid = resCid.get(client);
        const chans = cid ? clientChannels.get(cid) : undefined;
        if (!chans || chans.has(channel)) return true;
      }
      return false;
    });

    addBroadcastListener((channel, payload, serialized) => {
      let frame: string | null = null; // serialize at most once, only if a client wants it
      for (const client of sseClients) {
        const cid = resCid.get(client);
        const chans = cid ? clientChannels.get(cid) : undefined;
        if (chans && !chans.has(channel)) continue; // client filtered this channel out
        if (frame === null) frame = `event: ${channel}\ndata: ${serialized ?? JSON.stringify(payload)}\n\n`;
        if (!sseWriteFrame(client, frame)) {
          sseClients.delete(client);
          if (cid) clientChannels.delete(cid);
          client.destroy();
        }
      }
    });

    // Heartbeat: ping every open stream so idle intermediaries don't drop it and so
    // half-open/stalled clients get reaped (write fails or backs up → dropped).
    this.heartbeatTimer = setInterval(() => {
      for (const client of sseClients) {
        // ": ..." is an SSE comment line — EventSource ignores it; it just exercises
        // the write so a half-open or stalled client surfaces and gets reaped.
        let ok = !client.writableEnded && !client.destroyed && client.writableLength <= SSE_MAX_BUFFER_BYTES;
        if (ok) {
          try {
            client.write(`: ping\n\n`);
          } catch {
            ok = false;
          }
        }
        if (!ok) {
          sseClients.delete(client);
          client.destroy();
        }
      }
    }, SSE_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();

    // One request handler, shared by both listeners (PORT + the friendly port).
    const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const pathname = url.pathname;

      if (DEBUG_HTTP) console.log(`[remote-server] ${req.method} ${pathname}`);

      // CORS preflight. A cross-site caller is only offered the safe methods, so
      // the browser blocks a state-changing request before it is ever sent.
      if (req.method === "OPTIONS") {
        cors(res);
        if (isCrossOrigin(req.headers.origin, req.headers.host)) {
          res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        }
        res.writeHead(204);
        res.end();
        return;
      }

      cors(res);

      // Enforcement, independent of whatever the preflight advertised: reads stay
      // open (LAN appliance), writes must be same-origin.
      if (MUTATING_METHODS.has(req.method ?? "") && isCrossOrigin(req.headers.origin, req.headers.host)) {
        console.warn(`[remote-server] rejected cross-origin ${scrub(req.method)} ${scrub(pathname)} from ${scrub(req.headers.origin)}`);
        error(res, "cross-origin request rejected", 403);
        return;
      }

      try {
        await this.handleRequest(req, res, pathname, url, req.method ?? "GET");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[remote-server] handler error ${scrub(pathname)}: ${scrub(msg)}`);
        error(res, msg, 500);
      }
    };

    const trackConn = (socket: net.Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    };

    this.server = http.createServer(handler);
    this.server.on("connection", trackConn);

    await this.listenWithRetry();

    // Friendly port (e.g. 80) so the LAN URL needs no port. Bound in addition to
    // PORT and self-healing: if it can't bind right now (e.g. the previous process
    // hasn't released it yet across a restart), keep serving PORT and RETRY in the
    // background until it succeeds — never fatal, and it reclaims 80 within seconds
    // of it becoming free. With the privilege granted (CAP_NET_BIND_SERVICE on prod)
    // the only failure mode is that transient restart race, which the retry closes.
    if (FRIENDLY_PORT && FRIENDLY_PORT !== PORT) {
      this.bindFriendlyPort(handler, trackConn);
    }
  }

  private bindFriendlyPort(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    trackConn: (socket: net.Socket) => void,
    attempt = 0,
  ): void {
    const friendly = http.createServer(handler);
    friendly.on("connection", trackConn);
    friendly.once("error", (err: NodeJS.ErrnoException) => {
      friendly.close();
      // Log the actionable reason once (first failure); stay quiet on subsequent retries.
      if (attempt === 0) {
        const why = err.code === "EACCES"
          ? `no privilege to bind port ${FRIENDLY_PORT} (Linux: re-run 'sudo ./scripts/install.sh' to grant CAP_NET_BIND_SERVICE)`
          : err.code === "EADDRINUSE"
            ? `port ${FRIENDLY_PORT} still in use (likely a restart releasing it)`
            : err.message;
        console.warn(`[remote-server] port ${FRIENDLY_PORT} not bound yet — ${why}. Serving :${PORT} and retrying in the background.`);
      }
      // Fast retries first (covers the restart-release race), then back off — but
      // never give up, so 80 is reclaimed the moment it frees up.
      const next = attempt + 1;
      const delay = next <= 5 ? 1000 : next <= 15 ? 5000 : 30000;
      this.friendlyRetryTimer = setTimeout(() => this.bindFriendlyPort(handler, trackConn, next), delay);
      this.friendlyRetryTimer.unref?.();
    });
    friendly.listen(FRIENDLY_PORT, "0.0.0.0", () => {
      this.friendlyServer = friendly;
      if (this.friendlyRetryTimer) { clearTimeout(this.friendlyRetryTimer); this.friendlyRetryTimer = null; }
      console.log(`[remote-server] also listening on 0.0.0.0:${FRIENDLY_PORT} (port-free URL)${attempt > 0 ? ` — bound after ${attempt} retr${attempt === 1 ? "y" : "ies"}` : ""}`);
    });
  }

  async stop(): Promise<void> {
    console.log("[remote-server] stopping");
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Force-close all tracked sockets so the server shuts down promptly.
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (this.friendlyRetryTimer) {
      clearTimeout(this.friendlyRetryTimer);
      this.friendlyRetryTimer = null;
    }
    if (this.friendlyServer) {
      await new Promise<void>((resolve) => this.friendlyServer!.close(() => resolve()));
      this.friendlyServer = null;
    }

    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
    console.log("[remote-server] stopped");
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    _url: URL,
    method: string,
  ): Promise<void> {
    // ── Uploaded custom-layout images ─────────────────────────────────────
    // Served before static so the SPA fallback doesn't swallow /layout-images/*.
    {
      const imgMatch = pathname.match(/^\/layout-images\/([^/]+)$/);
      if (method === "GET" && imgMatch) {
        const img = await readLayoutImage(decodeURIComponent(imgMatch[1]));
        if (!img) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        // Content-hashed name → immutable, cache forever.
        res.writeHead(200, { "Content-Type": img.mime, "Cache-Control": "public, max-age=31536000, immutable" });
        res.end(img.data);
        return;
      }
    }
    // ── Branding images (app logo, empty-slot logo, avatar) ───────────────
    // Same content-hashed, cache-forever treatment. These used to ride in
    // stage:state as base64 and were 77% of every broadcast.
    {
      const brandMatch = pathname.match(/^\/branding-images\/([^/]+)$/);
      if (method === "GET" && brandMatch) {
        const img = await readImage(BRANDING_IMAGE_DIR, decodeURIComponent(brandMatch[1]));
        if (!img) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": img.mime, "Cache-Control": "public, max-age=31536000, immutable" });
        res.end(img.data);
        return;
      }
    }
    if (method === "POST" && pathname === "/api/layout-images") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.dataUrl !== "string") {
        error(res, "body.dataUrl (base64 data:image/… URL) required");
        return;
      }
      try {
        json(res, { url: await saveLayoutImage(body.dataUrl) });
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }

    // ── Server log viewer ─────────────────────────────────────────────────
    // Handled before static serving so the SPA fallback doesn't swallow /log.
    if (method === "GET" && pathname === "/log") {
      if (!logAuthed(_url)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized — append ?token=…");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(renderLogPage());
      return;
    }
    if (method === "GET" && pathname === "/api/log") {
      if (!logAuthed(_url)) {
        error(res, "unauthorized", 401);
        return;
      }
      json(res, { lines: getLogLines() });
      return;
    }

    // ── Serve renderer static build (standalone mode) ─────────────────────
    // Serves the Vite-built renderer from build/renderer/ when it exists.
    if (method === "GET" && !pathname.startsWith("/api/") && pathname !== "/photos") {
      const staticServed = await this.tryServeStatic(pathname, res, req.headers["accept-encoding"] as string | undefined);
      if (staticServed) return;
      // Fall through to the phone control page.
    }

    // ── Serve the phone control page (legacy fallback) ────────────────────
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const resolved = await this.resolveControlHtml();
      if (resolved) {
        try {
          const html = await fs.readFile(resolved, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch {
          res.writeHead(500);
          res.end("Error reading control page");
        }
      } else {
        res.writeHead(404);
        res.end("Control page not found");
      }
      return;
    }

    // Running code version — an installed PWA polls this on foreground to detect
    // a stale cached shell and reload (see useStageState). Never cached.
    if (method === "GET" && pathname === "/api/version") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ version: SERVER_VERSION }));
      return;
    }

    // ── SSE event stream ──────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // disable proxy buffering (nginx etc.)
      });
      // Advertise the running code version so a kiosk that reconnects after an
      // update/restart and sees a new version reloads itself (see useStageState).
      sseWrite(res, "server:hello", { version: SERVER_VERSION });
      // Send initial snapshots so the client is immediately in sync — these
      // channels otherwise only broadcast on change, leaving a fresh client blank.
      stageController.ensureResolvedFresh(); // fold in any device status that changed while idle
      sseWrite(res, "stage:state-changed", stageController.getState());
      sseWrite(res, "pco:live", stageController.getLastLive());
      sseWrite(res, "propresenter:status", propresenterService.getStatus());
      sseWrite(res, "propresenter:instances", propresenterManager.getInstancesDto());
      sseWrite(res, "spl:metrics", smaartService.getLatest());
      sseWrite(res, "spl:history", splRecorder.getCurrent());
      sseWrite(res, "attendance:history", attendanceRecorder.getCurrent());
      sseWrite(res, "service-timeline:history", serviceTimelineRecorder.getCurrent());
      sseWrite(res, "baptism:state", baptismTimerService.getState());
      sseWrite(res, "obs:status", obsService.getLatest());
      sseWrite(res, "reaper:status", reaperService.getLatest());
      // Update status must hydrate on (re)connect: every update ends by restarting
      // the server, which drops+reconnects this socket. Without this, the settings
      // Updates panel never learns the post-restart state and stays stuck on its
      // last-seen step ("Downloading…") until a manual refresh.
      sseWrite(res, "update:status", updater.getStatus());
      sseWrite(res, "osc:feedback", oscManager.getFeedback());
      sseWrite(res, "people:count", sensourceService.getLatest());
      sseWrite(res, "displays:presence", presenceSnapshot());
      sseClients.add(res);
      // Correlate this stream to its client id so POST /api/events/subscribe can set
      // its channel filter. No cid (or no report yet) → the fan-out sends everything.
      const cid = _url.searchParams.get("cid");
      if (cid) resCid.set(res, cid);
      // A Companion module marks its event stream so we can show a live
      // connected-client count in the integration panel. Re-broadcast the
      // integration states so the count updates everywhere immediately.
      const isCompanion =
        req.headers["x-companion-module"] != null ||
        _url.searchParams.get("client") === "companion";
      if (isCompanion) {
        companionClients.add(res);
        integrationManager.setCompanionClients(companionClients.size);
      }
      req.on("close", () => {
        sseClients.delete(res);
        if (cid) clientChannels.delete(cid);
        if (isCompanion) {
          companionClients.delete(res);
          integrationManager.setCompanionClients(companionClients.size);
        }
      });
      return;
    }
    if (method === "POST" && pathname === "/api/events/subscribe") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      const cid = typeof body.cid === "string" ? body.cid : null;
      const channels = Array.isArray(body.channels)
        ? body.channels.filter((c): c is string => typeof c === "string")
        : null;
      if (cid && channels) clientChannels.set(cid, new Set(channels));
      json(res, { ok: cid != null && channels != null });
      return;
    }
    // Display presence heartbeat — a kiosk page reports it's alive (or leaving).
    // Powers the Connected/Offline dot on Settings → Displays.
    if (method === "POST" && pathname === "/api/displays/presence") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      const outputId = typeof body.outputId === "string" ? body.outputId : null;
      if (outputId) {
        if (body.leaving === true) displayLeaving(outputId);
        else displayHeartbeat(outputId);
      }
      json(res, { ok: outputId != null });
      return;
    }
    // Multi-sheet .xlsx export of service history — date range + which sheets via
    // query params (?from=&to=&include=services,attendance,items,spl).
    if (method === "GET" && pathname === "/api/history/export") {
      const VALID: HistorySheet[] = ["services", "attendance", "items", "spl", "baptisms"];
      const include = (_url.searchParams.get("include") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is HistorySheet => (VALID as string[]).includes(s));
      // Name the file after what is IN it, not the day it was made — an export of
      // the whole year and one of a single Sunday used to be indistinguishable.
      const from = _url.searchParams.get("from");
      const to = _url.searchParams.get("to");
      const buf = await buildHistoryWorkbook({ from, to, include });
      const fname = historyFileName(from, to);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fname}"`,
      });
      res.end(buf);
      return;
    }

    // ── Domain routes ─────────────────────────────────────────────────────
    // Each module owns one domain and is tried in order, exactly as when these
    // were one long if-chain. A module that responds ends the request; one that
    // matches nothing falls through. `res.headersSent` is the handled-signal,
    // which is why the route bodies moved out unchanged.
    const c: RouteCtx = { req, res, pathname, url: _url, method };
    await statusRoutes(c);
    if (res.headersSent) return;
    await historyRoutes(c);
    if (res.headersSent) return;
    await archiveRoutes(c);
    if (res.headersSent) return;
    await proxyRoutes(c);
    if (res.headersSent) return;
    await stateRoutes(c);
    if (res.headersSent) return;
    await scriptviewRoutes(c);
    if (res.headersSent) return;
    await viewRoutes(c);
    if (res.headersSent) return;
    await integrationRoutes(c);
    if (res.headersSent) return;
    await rosstalkRoutes(c);
    if (res.headersSent) return;
    await automationRoutes(c);
    if (res.headersSent) return;
    await displaySettingsRoutes(c);
    if (res.headersSent) return;
    await systemRoutes(c);
    if (res.headersSent) return;
    await brandingRoutes(c);
    if (res.headersSent) return;
    await presetRoutes(c);
    if (res.headersSent) return;

    // 404
    error(res, `Not found: ${method} ${pathname}`, 404);
  }
}

export const remoteServer = new RemoteServer();
