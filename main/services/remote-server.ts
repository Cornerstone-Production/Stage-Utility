// LAN HTTP server on port 8788.
// Serves public/control.html at GET / and the /api/* endpoints.
// Permissive CORS on /api/*. Tracks sockets for clean shutdown.

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "fs/promises";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "url";

import type { DisplayKind, LayoutDTO, LayoutObject, ScriptViewLayout, Slot, SlotsLayout } from "../types/stage.js";
import type { OscArg } from "../types/osc.js";
import { addBroadcastListener, setSubscriberCheck } from "./broadcaster.js";
import { getLogLines } from "./log-buffer.js";
import { editServiceWindow, mergeServiceRecords, recalcAttendance, setItemCounted } from "./history-edit.js";
import { saveLayoutImage, readLayoutImage } from "./layout-image-store.js";
import { deviceManager } from "./device-manager.js";
import { configSnapshot } from "./config-snapshot.js";
import { integrationManager } from "./integration-manager.js";
import { obsService } from "./obs-service.js";
import { oscManager } from "./osc-manager.js";
import { prodcomService } from "./prodcom-service.js";
import { propresenterService, propresenterManager, THUMBNAIL_QUALITY as PROPRESENTER_THUMBNAIL_QUALITY } from "./propresenter-service.js";
import { sensourceService } from "./sensource-service.js";
import { smaartService } from "./smaart-service.js";
import { splHistoryStore } from "./spl-history-store.js";
import { splRecorder } from "./spl-recorder.js";
import { attendanceStore } from "./attendance-store.js";
import { attendanceRecorder } from "./attendance-recorder.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { serviceTimelineRecorder } from "./service-timeline-recorder.js";
import { baptismTimerService } from "./baptism-timer-service.js";
import { stageController } from "./stage-controller.js";
import { updater } from "./updater.js";
import { wirelessManager } from "./wireless-manager.js";

// ── Static renderer build path candidates ──────────────────────────────────────
// In standalone mode the renderer is built to build/renderer/ relative to cwd.
const RENDERER_BUILD_DIR = path.join(process.cwd(), "build", "renderer");

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
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * A stable id for the currently-running code, advertised to kiosks on every SSE
 * connect (the "server:hello" event). A display that reconnects after a restart
 * and sees a *different* version reloads itself, so updates roll out to screens
 * automatically. Git short SHA when available (changes only on a real update,
 * not a plain crash-restart); else a hash of the built index.html (changes when
 * the frontend bundle changes). "unknown" disables the auto-reload (never false).
 */
function computeServerVersion(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    // not a git checkout — fall through
  }
  try {
    const html = readFileSync(path.join(RENDERER_BUILD_DIR, "index.html"));
    return "b" + crypto.createHash("sha1").update(html).digest("hex").slice(0, 8);
  } catch {
    // no build present
  }
  return "unknown";
}
const SERVER_VERSION = computeServerVersion();

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

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

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
function render(){var f=filterEl.value.toLowerCase();var atBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-40);
var shown=lines.filter(function(l){return !f||l.msg.toLowerCase().indexOf(f)>=0||l.level.indexOf(f)>=0});
countEl.textContent=shown.length+' / '+lines.length+' lines';
logEl.innerHTML=shown.map(function(l){return '<div class="ln '+l.level+'"><span class="t">'+esc(l.t).slice(11,19)+'</span> '+esc(l.msg)+'</div>'}).join('');
if(autoEl.checked&&atBottom)window.scrollTo(0,document.body.scrollHeight)}
function load(){fetch('/api/log'+q).then(function(r){return r.json()}).then(function(d){lines=d.lines||[];render()}).catch(function(){})}
filterEl.oninput=render;document.getElementById('refresh').onclick=load;load();setInterval(function(){if(autoEl.checked)load()},2000);
</script></body></html>`;
}

/** Whether a live service / active recording is in progress, and why. Used to lock
 *  self-updates (which restart the process and would interrupt a service mid-flight
 *  and drop the last un-persisted samples) unless the operator explicitly overrides. */
function serviceActivity(): { active: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (stageController.getLastLive()?.mode === "item") reasons.push("A PCO service is live");
  const spl = splRecorder.getCurrent();
  if (spl && !spl.endedAt) reasons.push("SPL is recording");
  const att = attendanceRecorder.getCurrent();
  if (att && !att.endedAt) reasons.push("Attendance is recording");
  const tl = serviceTimelineRecorder.getCurrent();
  if (tl && !tl.endedAt) reasons.push("Service history is recording");
  return { active: reasons.length > 0, reasons };
}

function isDisplayKind(v: unknown): v is DisplayKind {
  return (
    v === "slots" ||
    v === "dashboard" ||
    v === "stage" ||
    v === "transcription" ||
    v === "custom" ||
    v === "script" ||
    v === "spl-rundown"
  );
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
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

// Small FIFO cache of ProPresenter slide thumbnails, keyed by the per-slide
// cache-bust token. Lets multiple displays showing the same slide share one
// upstream fetch instead of each hitting ProPresenter.
const thumbnailCache = new Map<string, { buf: Buffer; contentType: string }>();

// Exit so the service manager (systemd/launchd/NSSM Restart=always) relaunches us
// — used after restoring a config snapshot so every integration re-initializes
// from the restored files. The HTTP response is flushed first.
function scheduleRestart(): void {
  setTimeout(() => process.exit(0), 1200);
}

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
      path.join(process.cwd(), "control.html"),             // cwd
      path.join(process.cwd(), "public", "control.html"),  // public/
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
      sendStatic(res, data, mime, cacheControl, ext, acceptEncoding, immutable ? candidate : null);
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

      // CORS preflight
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
    };

    const trackConn = (socket: net.Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    };

    this.server = http.createServer(handler);
    this.server.on("connection", trackConn);

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(PORT, "0.0.0.0", () => {
        console.log(`[remote-server] listening on 0.0.0.0:${PORT} (LAN: ${this.getLanUrl()})`);
        resolve();
      });
      this.server!.on("error", reject);
    });

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
      sseWrite(res, "osc:feedback", oscManager.getFeedback());
      sseWrite(res, "people:count", sensourceService.getLatest());
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

    // Hydrate-on-connect endpoints (the live channels only broadcast on change).
    if (method === "GET" && pathname === "/api/propresenter/status") {
      json(res, propresenterService.getStatus());
      return;
    }
    if (method === "GET" && pathname === "/api/propresenter/instances") {
      json(res, propresenterManager.getInstancesDto());
      return;
    }
    if (method === "GET" && pathname === "/api/pco/live") {
      json(res, await stageController.fetchLive());
      return;
    }
    if (method === "GET" && pathname === "/api/spl/metrics") {
      json(res, smaartService.getLatest());
      return;
    }
    if (method === "GET" && pathname === "/api/obs/status") {
      json(res, obsService.getLatest());
      return;
    }
    if (method === "GET" && pathname === "/api/osc/feedback") {
      json(res, oscManager.getFeedback());
      return;
    }
    if (method === "GET" && pathname === "/api/people/count") {
      json(res, sensourceService.getLatest());
      return;
    }
    if (method === "GET" && pathname === "/api/sensource/locations") {
      try {
        json(res, await integrationManager.getSensourceLocations());
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 502);
      }
      return;
    }
    if (method === "GET" && pathname === "/api/sensource/zones") {
      try {
        json(res, await integrationManager.getSensourceZones());
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 502);
      }
      return;
    }
    if (method === "GET" && pathname === "/api/spl/history/current") {
      json(res, splRecorder.getCurrent());
      return;
    }
    if (method === "GET" && pathname === "/api/spl/history") {
      json(res, await splHistoryStore.list());
      return;
    }
    if (method === "GET" && pathname === "/api/spl/visible-metrics") {
      json(res, { metrics: await splHistoryStore.getVisibleMetrics() });
      return;
    }
    if (method === "POST" && pathname === "/api/spl/visible-metrics") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const metrics = Array.isArray(body.metrics) ? (body.metrics as unknown[]) : [];
      json(res, { metrics: await splHistoryStore.setVisibleMetrics(metrics as string[]) });
      return;
    }
    {
      const histMatch = pathname.match(/^\/api\/spl\/history\/([^/]+)$/);
      if (histMatch && histMatch[1] !== "current") {
        const key = decodeURIComponent(histMatch[1]);
        if (method === "GET") {
          json(res, await splHistoryStore.get(key));
          return;
        }
        if (method === "DELETE") {
          json(res, { deleted: await splHistoryStore.delete(key) });
          return;
        }
      }
    }

    // ── Attendance history (mirrors the SPL history routes) ─────────────────
    if (method === "POST" && pathname === "/api/history/window") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.serviceKey !== "string") {
        error(res, "body.serviceKey (string) required");
        return;
      }
      await editServiceWindow(body.serviceKey, {
        startedAt: typeof body.startedAt === "string" ? body.startedAt : undefined,
        endedAt: typeof body.endedAt === "string" ? body.endedAt : undefined,
      });
      json(res, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/history/recalc") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.serviceKey !== "string") {
        error(res, "body.serviceKey (string) required");
        return;
      }
      await recalcAttendance(body.serviceKey);
      json(res, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/history/item-counted") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.serviceKey !== "string" || typeof body.itemId !== "string" || typeof body.counted !== "boolean") {
        error(res, "body.serviceKey, body.itemId (strings) + body.counted (boolean) required");
        return;
      }
      await setItemCounted(body.serviceKey, body.itemId, body.counted);
      json(res, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/history/merge") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.sourceKey !== "string" || typeof body.targetKey !== "string") {
        error(res, "body.sourceKey + body.targetKey (strings) required");
        return;
      }
      await mergeServiceRecords(body.sourceKey, body.targetKey);
      json(res, { ok: true });
      return;
    }
    if (method === "GET" && pathname === "/api/attendance/history/current") {
      json(res, attendanceRecorder.getCurrent());
      return;
    }
    if (method === "GET" && pathname === "/api/attendance/history") {
      json(res, await attendanceStore.list());
      return;
    }
    {
      const attMatch = pathname.match(/^\/api\/attendance\/history\/([^/]+)$/);
      if (attMatch && attMatch[1] !== "current") {
        const key = decodeURIComponent(attMatch[1]);
        if (method === "GET") {
          json(res, await attendanceStore.get(key));
          return;
        }
        if (method === "DELETE") {
          json(res, { deleted: await attendanceStore.delete(key) });
          return;
        }
      }
    }

    // ── Service timeline (actual rundown timing; mirrors the SPL/attendance routes) ──
    if (method === "GET" && pathname === "/api/service-timeline/current") {
      json(res, serviceTimelineRecorder.getCurrent());
      return;
    }
    if (method === "GET" && pathname === "/api/service-timeline") {
      json(res, await serviceTimelineStore.list());
      return;
    }
    {
      const tlMatch = pathname.match(/^\/api\/service-timeline\/([^/]+)$/);
      if (tlMatch && tlMatch[1] !== "current") {
        const key = decodeURIComponent(tlMatch[1]);
        if (method === "GET") {
          json(res, await serviceTimelineStore.get(key));
          return;
        }
        if (method === "DELETE") {
          json(res, { deleted: await serviceTimelineStore.delete(key) });
          return;
        }
      }
    }

    // ── Baptism timer ───────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/baptism") {
      json(res, baptismTimerService.getState());
      return;
    }
    if (method === "GET" && pathname === "/api/baptism/sessions") {
      json(res, await baptismTimerService.listSessions());
      return;
    }
    if (method === "POST" && pathname.startsWith("/api/baptism/")) {
      const action = pathname.slice("/api/baptism/".length);
      switch (action) {
        case "start": json(res, baptismTimerService.start()); return;
        case "baptized": json(res, baptismTimerService.baptized()); return;
        case "start-baptisms": json(res, baptismTimerService.startBaptisms()); return;
        case "next": json(res, baptismTimerService.next()); return;
        case "undo": json(res, baptismTimerService.undo()); return;
        case "finish": json(res, baptismTimerService.finish()); return;
        case "reset": json(res, baptismTimerService.reset()); return;
        case "mode": {
          const body = (await readBody(req)) as Record<string, unknown>;
          json(res, baptismTimerService.setMode(body.mode === "grouped" ? "grouped" : "per-person"));
          return;
        }
      }
    }
    {
      const bapSessionMatch = pathname.match(/^\/api\/baptism\/sessions\/([^/]+)$/);
      if (bapSessionMatch && method === "DELETE") {
        json(res, { deleted: await baptismTimerService.deleteSession(decodeURIComponent(bapSessionMatch[1])) });
        return;
      }
    }

    // List the current plan's attachments (powers the layout editor's file picker).
    if (method === "GET" && pathname === "/api/pco/attachments") {
      json(res, await stageController.listPlanAttachments());
      return;
    }

    // Full rundown of the current plan (items + note columns) for the script /
    // SPL-rundown dashboards.
    if (method === "GET" && pathname === "/api/pco/plan-items") {
      json(res, await stageController.listCurrentPlanItems());
      return;
    }

    // ── PCO plan-attachment proxy (e.g. the stage plot) ──────────────────────
    // Streams the current plan's attachment matching ?match=<filename substring>,
    // proxied + cached so kiosk displays get a stable URL that always tracks the
    // CURRENT plan. Resolving by filename (not id) means the same layout object
    // shows the right file every week without re-pointing.
    if (method === "GET" && pathname === "/api/pco/attachment") {
      const match = _url.searchParams.get("match") ?? "";
      try {
        const att = await stageController.findPlanAttachment(match);
        if (!att) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("No matching attachment on the current plan");
          return;
        }
        const { getAttachmentFile, mimeForExt } = await import("./pco-attachment-cache.js");
        const file = await getAttachmentFile(
          att.id,
          att.contentType,
          att.filename,
          async () => (await stageController.openPlanAttachment(att.id)).url,
        );
        if (!file) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Could not download attachment from Planning Center");
          return;
        }
        const data = await fs.readFile(file.path);
        res.writeHead(200, {
          "Content-Type": mimeForExt(file.ext),
          // Bytes are immutable per attachment id; cache briefly so a fresh plan
          // (new id, new URL) is picked up within a few minutes on the displays.
          "Cache-Control": "private, max-age=300",
        });
        res.end(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(res, `Attachment error: ${msg}`, 500);
      }
      return;
    }

    // ── PCO photo proxy (replaces stage-photo:// in standalone mode) ──────
    if (method === "GET" && pathname === "/photos") {
      const photoUrl = _url.searchParams.get("u");
      if (!photoUrl) {
        error(res, "u query param required");
        return;
      }
      try {
        const { getPhotoPath } = await import("./photo-cache.js");
        const localPath = await getPhotoPath(decodeURIComponent(photoUrl));
        if (!localPath) {
          res.writeHead(404);
          res.end("Photo not found");
          return;
        }
        const ext = localPath.split(".").pop()?.toLowerCase() ?? "jpg";
        const mime =
          ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
        const data = await fs.readFile(localPath);
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(res, `Photo error: ${msg}`, 500);
      }
      return;
    }

    // ── ProPresenter slide preview proxy (stage display) ─────────────────────
    // Pipes the current slide's JPEG thumbnail from ProPresenter so the kiosk can
    // show it without reaching ProPresenter directly (works in prod; no CORS). The
    // ?k=<slidePreviewKey> param just cache-busts per slide — the source is the
    // service's current target. 21.3 returns real image/jpeg, so no decode.
    if (method === "GET" && pathname === "/api/propresenter/thumbnail") {
      // `?i=` selects which ProPresenter instance ("default"/absent = primary).
      const target = propresenterManager.getThumbnailTarget(_url.searchParams.get("i"));
      if (!target) {
        res.writeHead(503);
        res.end("ProPresenter not connected / no active slide");
        return;
      }
      // Cache the fetched image so N displays showing the same slide don't each
      // hit ProPresenter. Key on the client's cache-bust token (`?k=` = the
      // slidePreviewKey, which changes per slide), else the slide's uuid:index.
      const cacheKey = _url.searchParams.get("k") || `${target.uuid}:${target.index}`;
      const hit = thumbnailCache.get(cacheKey);
      if (hit) {
        res.writeHead(200, { "Content-Type": hit.contentType, "Cache-Control": "no-store" });
        res.end(hit.buf);
        return;
      }
      const path = `/v1/presentation/${target.uuid}/thumbnail/${target.index}?quality=${PROPRESENTER_THUMBNAIL_QUALITY}`;
      const upstream = http.get({ host: target.host, port: target.port, path, timeout: 5000 }, (up) => {
        if ((up.statusCode ?? 0) >= 400) {
          up.resume();
          res.writeHead(502);
          res.end(`ProPresenter thumbnail HTTP ${up.statusCode}`);
          return;
        }
        const contentType = up.headers["content-type"] ?? "image/jpeg";
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
          const buf = Buffer.concat(chunks);
          // Bound the cache (FIFO) — slide keys are short-lived, a few is plenty.
          if (thumbnailCache.size >= 16) {
            const firstKey = thumbnailCache.keys().next().value;
            if (firstKey !== undefined) thumbnailCache.delete(firstKey);
          }
          thumbnailCache.set(cacheKey, { buf, contentType });
          res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
          res.end(buf);
        });
      });
      upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
      upstream.on("error", (e) => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(`ProPresenter thumbnail error: ${e.message}`);
        }
      });
      return;
    }

    // ── ProdCom transcript backfill (recent lines for a freshly-loaded display) ──
    if (method === "GET" && pathname === "/api/prodcom/transcript") {
      json(res, prodcomService.getBuffer());
      return;
    }

    // ── Health ────────────────────────────────────────────────────────────
    // Identity payload: lets an external client (e.g. the Bitfocus Companion
    // module) confirm it reached a Stage Utility server and show its version/name.
    if (method === "GET" && pathname === "/api/health") {
      json(res, {
        ok: true,
        app: "stage-utility",
        version: SERVER_VERSION,
        name: stageController.getState().appName,
      });
      return;
    }

    // ── Stage state ───────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/state") {
      json(res, stageController.getState());
      return;
    }

    if (method === "GET" && pathname === "/api/service-types") {
      const types = await stageController.listServiceTypes();
      json(res, types);
      return;
    }

    if (method === "GET" && pathname === "/api/team-positions") {
      const positions = await stageController.listTeamPositions();
      json(res, positions);
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

    // ── ScriptView (in-app ScriptViewer replacement) ─────────────────────────
    if (method === "GET" && pathname === "/api/scriptview/layouts") {
      json(res, await stageController.listScriptViewLayouts());
      return;
    }

    if (method === "POST" && pathname === "/api/scriptview/layouts") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.layouts)) {
        error(res, "body.layouts (array) required");
        return;
      }
      json(res, await stageController.saveScriptViewLayouts(body.layouts as ScriptViewLayout[]));
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/config") {
      json(res, await stageController.getScriptViewConfig());
      return;
    }

    if (method === "POST" && pathname === "/api/scriptview/config") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.serviceTypeIds)) {
        error(res, "body.serviceTypeIds (array) required");
        return;
      }
      json(res, await stageController.setScriptViewConfig(body.serviceTypeIds.map(String)));
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/note-categories") {
      const serviceTypeId = _url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      json(res, await stageController.listScriptViewNoteCategories(serviceTypeId));
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/rundown") {
      const serviceTypeId = _url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      const planId = _url.searchParams.get("planId");
      json(res, await stageController.getScriptViewRundown(serviceTypeId, planId));
      return;
    }

    if (method === "POST" && pathname === "/api/service-type") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.id !== "string") {
        error(res, "body.id (string) required");
        return;
      }
      const state = await stageController.setServiceType(body.id);
      json(res, state);
      return;
    }

    if (method === "POST" && pathname === "/api/plan") {
      const body = await readBody(req) as Record<string, unknown>;
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
      const body = await readBody(req) as Record<string, unknown>;
      if (body.mode !== "auto" && body.mode !== "manual") {
        error(res, 'body.mode must be "auto" or "manual"');
        return;
      }
      const state = await stageController.setPlanMode(body.mode as "auto" | "manual");
      json(res, state);
      return;
    }

    if (method === "POST" && pathname === "/api/refresh") {
      const state = await stageController.refresh();
      json(res, state);
      return;
    }

    // PCO Services Live timer controls (next / previous item).
    if (method === "POST" && (pathname === "/api/live/next" || pathname === "/api/live/previous")) {
      const direction = pathname.endsWith("/next") ? "next" : "previous";
      await stageController.controlLive(direction);
      json(res, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/slots") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      // Optional displayId — defaults to primary display if omitted.
      const displayId = typeof body.displayId === "string" ? body.displayId : "";
      const state = await stageController.setSlots(displayId, body.slots as Slot[]);
      json(res, state);
      return;
    }

    if (method === "GET" && pathname === "/api/displays") {
      json(res, stageController.getDisplays());
      return;
    }

    if (method === "POST" && pathname === "/api/displays") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const kind = isDisplayKind(body.kind) ? body.kind : "slots";
      const state = await stageController.addDisplay(name, kind);
      json(res, state, 201);
      return;
    }

    // PATCH /api/displays/:id — accepts { name? } and/or { kind? } and/or { ndiSource? }
    const displayPatchMatch = pathname.match(/^\/api\/displays\/([^/]+)$/);
    if (method === "PATCH" && displayPatchMatch) {
      const id = displayPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const hasName = typeof body.name === "string";
      const hasKind = isDisplayKind(body.kind);
      // ndiSource accepts a string (assign) or null (clear); absent = no change.
      const hasNdiSource = "ndiSource" in body
        && (typeof body.ndiSource === "string" || body.ndiSource === null);
      if (!hasName && !hasKind && !hasNdiSource) {
        error(res, "body.name (string), body.kind ('slots'|'dashboard'|'stage'|'transcription'), or body.ndiSource (string|null) required");
        return;
      }
      let state = stageController.getState();
      if (hasName) state = await stageController.renameDisplay(id, body.name as string);
      if (hasKind) state = await stageController.setDisplayKind(id, body.kind as DisplayKind);
      if (hasNdiSource) state = await stageController.setDisplayNdiSource(id, body.ndiSource as string | null);
      json(res, state);
      return;
    }

    // DELETE /api/displays/:id
    const displayDeleteMatch = pathname.match(/^\/api\/displays\/([^/]+)$/);
    if (method === "DELETE" && displayDeleteMatch) {
      const id = displayDeleteMatch[1];
      const state = await stageController.removeDisplay(id);
      json(res, state);
      return;
    }

    // ── Views (content definitions) ───────────────────────────────────────
    if (method === "GET" && pathname === "/api/views") {
      json(res, stageController.getViews());
      return;
    }

    if (method === "POST" && pathname === "/api/views") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const kind = isDisplayKind(body.kind) ? body.kind : "slots";
      const state = await stageController.createView(name ?? "", kind);
      json(res, state, 201);
      return;
    }

    // POST /api/views/reorder — { ids: string[] }
    if (method === "POST" && pathname === "/api/views/reorder") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.ids)) {
        error(res, "body.ids (string[]) required");
        return;
      }
      const state = await stageController.reorderViews(body.ids as string[]);
      json(res, state);
      return;
    }

    // POST /api/views/resolve-slots — { slots } → resolved Slot[] (no persist).
    // Powers the Views page live draft preview: resolves in-progress edits against
    // the current team + device state so the preview matches the kiosk, without
    // saving. Must precede the /api/views/:id/slots matcher.
    if (method === "POST" && pathname === "/api/views/resolve-slots") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      json(res, stageController.resolveSlotsPreview(body.slots as Slot[]));
      return;
    }

    // POST /api/views/:id/slots — { slots }
    const viewSlotsMatch = pathname.match(/^\/api\/views\/([^/]+)\/slots$/);
    if (method === "POST" && viewSlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const state = await stageController.setViewSlots(viewSlotsMatch[1], body.slots as Slot[]);
      json(res, state);
      return;
    }

    // POST /api/layout-objects/:objectId/slots — { slots } (inline mic-slots grid)
    const objectSlotsMatch = pathname.match(/^\/api\/layout-objects\/([^/]+)\/slots$/);
    if (method === "POST" && objectSlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const state = await stageController.setLayoutObjectSlots(objectSlotsMatch[1], body.slots as Slot[]);
      json(res, state);
      return;
    }

    // POST /api/views/:id/duplicate — { name? }
    const viewDuplicateMatch = pathname.match(/^\/api\/views\/([^/]+)\/duplicate$/);
    if (method === "POST" && viewDuplicateMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const state = await stageController.duplicateView(viewDuplicateMatch[1], name);
      json(res, state, 201);
      return;
    }

    // POST /api/views/:id/copy-slots — { fromViewId }
    const viewCopySlotsMatch = pathname.match(/^\/api\/views\/([^/]+)\/copy-slots$/);
    if (method === "POST" && viewCopySlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.fromViewId !== "string") {
        error(res, "body.fromViewId (string) required");
        return;
      }
      const state = await stageController.copyViewSlots(viewCopySlotsMatch[1], body.fromViewId);
      json(res, state);
      return;
    }

    // PATCH /api/views/:id — { name? } and/or { kind? } and/or { ndiSource? } and/or { layout? }
    const viewPatchMatch = pathname.match(/^\/api\/views\/([^/]+)$/);
    if (method === "PATCH" && viewPatchMatch) {
      const id = viewPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const hasName = typeof body.name === "string";
      const hasKind = isDisplayKind(body.kind);
      const hasNdiSource = "ndiSource" in body
        && (typeof body.ndiSource === "string" || body.ndiSource === null);
      const hasLayout = "layout" in body && body.layout != null && typeof body.layout === "object";
      const hasSlotsLayout = "slotsLayout" in body
        && (body.slotsLayout === null || typeof body.slotsLayout === "object");
      const hasShowLiveControls = typeof body.showLiveControls === "boolean";
      if (!hasName && !hasKind && !hasNdiSource && !hasLayout && !hasSlotsLayout && !hasShowLiveControls) {
        error(res, "body.name (string), body.kind, body.ndiSource (string|null), body.layout (object), body.slotsLayout (object|null), or body.showLiveControls (boolean) required");
        return;
      }
      let state = stageController.getState();
      if (hasName) state = await stageController.renameView(id, body.name as string);
      if (hasKind) state = await stageController.setViewKind(id, body.kind as DisplayKind);
      if (hasNdiSource) state = await stageController.setViewNdiSource(id, body.ndiSource as string | null);
      if (hasLayout) state = await stageController.setViewLayout(id, body.layout as LayoutDTO);
      if (hasSlotsLayout) state = await stageController.setViewSlotsLayout(id, body.slotsLayout as SlotsLayout | null);
      if (hasShowLiveControls) state = await stageController.setViewShowLiveControls(id, body.showLiveControls as boolean);
      json(res, state);
      return;
    }

    // DELETE /api/views/:id
    const viewDeleteMatch = pathname.match(/^\/api\/views\/([^/]+)$/);
    if (method === "DELETE" && viewDeleteMatch) {
      const state = await stageController.deleteView(viewDeleteMatch[1]);
      json(res, state);
      return;
    }

    // ── Layout templates (reusable custom layouts) ────────────────────────
    if (method === "GET" && pathname === "/api/layout-templates") {
      json(res, await stageController.listLayoutTemplates());
      return;
    }

    if (method === "POST" && pathname === "/api/layout-templates") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.name !== "string" || body.layout == null || typeof body.layout !== "object") {
        error(res, "body.name (string) and body.layout (object) required");
        return;
      }
      const list = await stageController.saveLayoutTemplate(body.name, body.layout as LayoutDTO);
      json(res, list, 201);
      return;
    }

    const tplPatchMatch = pathname.match(/^\/api\/layout-templates\/([^/]+)$/);
    if (method === "PATCH" && tplPatchMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      const patch: { name?: string; layout?: LayoutDTO } = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (body.layout != null && typeof body.layout === "object") patch.layout = body.layout as LayoutDTO;
      if (patch.name === undefined && patch.layout === undefined) {
        error(res, "body.name (string) or body.layout (object) required");
        return;
      }
      const list = await stageController.updateLayoutTemplate(tplPatchMatch[1], patch);
      json(res, list);
      return;
    }

    const tplDeleteMatch = pathname.match(/^\/api\/layout-templates\/([^/]+)$/);
    if (method === "DELETE" && tplDeleteMatch) {
      const list = await stageController.deleteLayoutTemplate(tplDeleteMatch[1]);
      json(res, list);
      return;
    }

    // ── Layout groups (reusable object/container library) ─────────────────
    if (method === "GET" && pathname === "/api/layout-groups") {
      json(res, await stageController.listLayoutGroups());
      return;
    }

    if (method === "POST" && pathname === "/api/layout-groups") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.name !== "string" || body.object == null || typeof body.object !== "object") {
        error(res, "body.name (string) and body.object (object) required");
        return;
      }
      const list = await stageController.saveLayoutGroup(body.name, body.object as LayoutObject);
      json(res, list, 201);
      return;
    }

    const grpDeleteMatch = pathname.match(/^\/api\/layout-groups\/([^/]+)$/);
    if (method === "DELETE" && grpDeleteMatch) {
      const list = await stageController.deleteLayoutGroup(grpDeleteMatch[1]);
      json(res, list);
      return;
    }

    // ── Outputs (physical screens + routing) ──────────────────────────────
    if (method === "GET" && pathname === "/api/outputs") {
      json(res, stageController.getOutputs());
      return;
    }

    if (method === "POST" && pathname === "/api/outputs") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const viewId = typeof body.viewId === "string" ? body.viewId : null;
      const state = await stageController.addOutput(name, viewId);
      json(res, state, 201);
      return;
    }

    // POST /api/outputs/reorder — { ids: string[] }
    if (method === "POST" && pathname === "/api/outputs/reorder") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.ids)) {
        error(res, "body.ids (string[]) required");
        return;
      }
      const state = await stageController.reorderOutputs(body.ids as string[]);
      json(res, state);
      return;
    }

    // PATCH /api/outputs/:id — { name? }, { viewId? } (string|null = routing),
    // and/or { blackout? } (boolean = full black screen)
    const outputPatchMatch = pathname.match(/^\/api\/outputs\/([^/]+)$/);
    if (method === "PATCH" && outputPatchMatch) {
      const id = outputPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const hasName = typeof body.name === "string";
      const hasViewId = "viewId" in body
        && (typeof body.viewId === "string" || body.viewId === null);
      const hasBlackout = typeof body.blackout === "boolean";
      const hasLocked = typeof body.locked === "boolean";
      if (!hasName && !hasViewId && !hasBlackout && !hasLocked) {
        error(res, "body.name (string), body.viewId (string|null), body.blackout (boolean), or body.locked (boolean) required");
        return;
      }
      let state = stageController.getState();
      if (hasName) state = await stageController.renameOutput(id, body.name as string);
      if (hasViewId) state = await stageController.setOutputView(id, body.viewId as string | null);
      if (hasBlackout) state = await stageController.setOutputBlackout(id, body.blackout as boolean);
      if (hasLocked) state = await stageController.setOutputLocked(id, body.locked as boolean);
      json(res, state);
      return;
    }

    // DELETE /api/outputs/:id
    const outputDeleteMatch = pathname.match(/^\/api\/outputs\/([^/]+)$/);
    if (method === "DELETE" && outputDeleteMatch) {
      const state = await stageController.removeOutput(outputDeleteMatch[1]);
      json(res, state);
      return;
    }

    if (method === "POST" && pathname === "/api/allowed-service-types") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.ids)) {
        error(res, "body.ids (string[]) required");
        return;
      }
      const state = await stageController.setAllowedServiceTypes(body.ids as string[]);
      json(res, state);
      return;
    }

    // ── Integrations ──────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/integrations") {
      json(res, {
        descriptors: integrationManager.getDescriptors(),
        states: integrationManager.getStates(),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/integrations/wireless/channels") {
      const channels = await deviceManager.listChannels();
      json(res, channels);
      return;
    }

    // ── Wireless connections ───────────────────────────────────────────────

    if (method === "GET" && pathname === "/api/wireless/meter-rate") {
      json(res, { ms: wirelessManager.getMeterRate() });
      return;
    }

    if (method === "POST" && pathname === "/api/wireless/meter-rate") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.ms !== "number" || body.ms < 0) {
        error(res, "body.ms (non-negative number) required");
        return;
      }
      const result = await wirelessManager.setMeterRate(body.ms);
      json(res, result);
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
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const providerId = typeof body.providerId === "string" ? body.providerId : undefined;
      const connections = await wirelessManager.addConnection({ name, providerId });
      json(res, connections, 201);
      return;
    }

    // PATCH or POST /api/wireless/connections/:id
    const wirelessConnMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)$/);
    if ((method === "PATCH" || method === "POST") && wirelessConnMatch) {
      const id = wirelessConnMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const rawPatch = (body.patch ?? body) as Record<string, unknown>;
      const patch: {
        name?: string;
        providerId?: string;
        enabled?: boolean;
        config?: Record<string, unknown>;
      } = {};
      if (typeof rawPatch.name === "string") patch.name = rawPatch.name;
      if (typeof rawPatch.providerId === "string") patch.providerId = rawPatch.providerId;
      if (typeof rawPatch.enabled === "boolean") patch.enabled = rawPatch.enabled;
      if (typeof rawPatch.config === "object" && rawPatch.config !== null) {
        patch.config = rawPatch.config as Record<string, unknown>;
      }
      const connections = await wirelessManager.updateConnection({ id, patch });
      json(res, connections);
      return;
    }

    // DELETE /api/wireless/connections/:id
    const wirelessConnDeleteMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)$/);
    if (method === "DELETE" && wirelessConnDeleteMatch) {
      const id = wirelessConnDeleteMatch[1];
      const connections = await wirelessManager.removeConnection({ id });
      json(res, connections);
      return;
    }

    // POST /api/wireless/connections/:id/test
    const wirelessTestMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)\/test$/);
    if (method === "POST" && wirelessTestMatch) {
      const id = wirelessTestMatch[1];
      const result = await wirelessManager.testConnection({ id });
      json(res, result);
      return;
    }

    // ── OSC ────────────────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/osc/targets") {
      json(res, oscManager.listTargets());
      return;
    }
    if (method === "POST" && pathname === "/api/osc/targets") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const targets = await oscManager.addTarget({ name });
      integrationManager.refreshOscSummary();
      json(res, targets, 201);
      return;
    }
    // POST /api/osc/send — { targetId, address, args? }
    if (method === "POST" && pathname === "/api/osc/send") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.targetId !== "string" || typeof body.address !== "string") {
        error(res, "body.targetId (string) and body.address (string) required");
        return;
      }
      const args = Array.isArray(body.args) ? (body.args as OscArg[]) : [];
      try {
        const result = await oscManager.send(body.targetId, body.address, args);
        json(res, result);
      } catch (err) {
        error(res, err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (method === "GET" && pathname === "/api/osc/feedback-port") {
      json(res, { port: oscManager.getFeedbackPort() });
      return;
    }
    if (method === "POST" && pathname === "/api/osc/feedback-port") {
      const body = await readBody(req) as Record<string, unknown>;
      const port = typeof body.port === "number" ? body.port : parseInt(String(body.port), 10);
      if (!Number.isFinite(port)) {
        error(res, "body.port (number) required");
        return;
      }
      json(res, await oscManager.setFeedbackPort(port));
      return;
    }
    // POST /api/osc/targets/:id/test
    const oscTestMatch = pathname.match(/^\/api\/osc\/targets\/([^/]+)\/test$/);
    if (method === "POST" && oscTestMatch) {
      const result = await oscManager.testTarget({ id: oscTestMatch[1] });
      json(res, result);
      return;
    }
    // PATCH or POST /api/osc/targets/:id
    const oscTargetMatch = pathname.match(/^\/api\/osc\/targets\/([^/]+)$/);
    if ((method === "PATCH" || method === "POST") && oscTargetMatch) {
      const id = oscTargetMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const rawPatch = (body.patch ?? body) as Record<string, unknown>;
      const patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> } = {};
      if (typeof rawPatch.name === "string") patch.name = rawPatch.name;
      if (typeof rawPatch.enabled === "boolean") patch.enabled = rawPatch.enabled;
      if (typeof rawPatch.config === "object" && rawPatch.config !== null) {
        patch.config = rawPatch.config as Record<string, unknown>;
      }
      const targets = await oscManager.updateTarget({ id, patch });
      integrationManager.refreshOscSummary();
      json(res, targets);
      return;
    }
    // DELETE /api/osc/targets/:id
    if (method === "DELETE" && oscTargetMatch) {
      const targets = await oscManager.removeTarget({ id: oscTargetMatch[1] });
      integrationManager.refreshOscSummary();
      json(res, targets);
      return;
    }

    // POST /api/integrations/:id/config
    const configMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/config$/);
    if (method === "POST" && configMatch) {
      const id = configMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.config !== "object" || body.config === null) {
        error(res, "body.config (object) required");
        return;
      }
      const state = await integrationManager.setConfig(
        id,
        body.config as Record<string, unknown>,
      );
      json(res, state);
      return;
    }

    // POST /api/integrations/:id/enabled
    const enabledMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/enabled$/);
    if (method === "POST" && enabledMatch) {
      const id = enabledMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.enabled !== "boolean") {
        error(res, "body.enabled (boolean) required");
        return;
      }
      const state = await integrationManager.setEnabled(id, body.enabled);
      json(res, state);
      return;
    }

    // POST /api/integrations/:id/test
    const testMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/test$/);
    if (method === "POST" && testMatch) {
      const id = testMatch[1];
      const result = await integrationManager.test(id);
      json(res, result);
      return;
    }

    // ── QR visibility ─────────────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/show-qr") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.show !== "boolean") {
        error(res, "body.show (boolean) required");
        return;
      }
      const state = await stageController.setShowQr(body.show);
      json(res, state);
      return;
    }

    // ── Onboarding checklist dismissal ─────────────────────────────────────
    if (method === "POST" && pathname === "/api/onboarding-dismissed") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.dismissed !== "boolean") {
        error(res, "body.dismissed (boolean) required");
        return;
      }
      const state = await stageController.setOnboardingDismissed(body.dismissed);
      json(res, state);
      return;
    }

    // ── Remote display refresh ──────────────────────────────────────────────
    // POST /api/displays/refresh — reload kiosk pages. Optional body.id targets
    // a single output; omitted/empty reloads all connected displays.
    if (method === "POST" && pathname === "/api/displays/refresh") {
      const body = await readBody(req) as Record<string, unknown>;
      const target = typeof body.id === "string" ? body.id : "";
      stageController.refreshDisplays(target);
      json(res, { ok: true, target: target || "all" });
      return;
    }

    // ── NDI visibility ──────────────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/ndi-enabled") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.enabled !== "boolean") {
        error(res, "body.enabled (boolean) required");
        return;
      }
      const state = await stageController.setNdiEnabled(body.enabled);
      json(res, state);
      return;
    }

    // ── Public URL (DNS) ────────────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/public-url") {
      const body = await readBody(req) as Record<string, unknown>;
      const url = typeof body.url === "string" ? body.url : null;
      const state = await stageController.setPublicUrl(url);
      json(res, state);
      return;
    }

    // ── Caption channel colors ──────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/caption-colors") {
      const body = await readBody(req) as Record<string, unknown>;
      const channel = typeof body.channel === "string" ? body.channel : "";
      const color = typeof body.color === "string" ? body.color : null;
      const state = await stageController.setCaptionChannelColor(channel, color);
      json(res, state);
      return;
    }

    // ── In-app self-update ────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/update/status") {
      json(res, updater.getStatus());
      return;
    }
    if (method === "POST" && pathname === "/api/update/check") {
      json(res, await updater.checkForUpdate());
      return;
    }
    if (method === "GET" && pathname === "/api/update/lock") {
      json(res, serviceActivity());
      return;
    }
    if (method === "POST" && pathname === "/api/update/apply") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      const lock = serviceActivity();
      if (lock.active && body.override !== true) {
        json(res, { error: "locked", locked: true, reasons: lock.reasons }, 409);
        return;
      }
      try {
        json(res, await updater.applyUpdate());
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    if (method === "POST" && pathname === "/api/update/track") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.branch !== "string") {
        error(res, "body.branch (string) required");
        return;
      }
      const lock = serviceActivity();
      if (lock.active && body.override !== true) {
        json(res, { error: "locked", locked: true, reasons: lock.reasons }, 409);
        return;
      }
      try {
        json(res, await updater.switchTrack(body.branch));
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    if (method === "POST" && pathname === "/api/update/restart") {
      try {
        json(res, updater.restart());
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    if (method === "POST" && pathname === "/api/update/auto") {
      const body = await readBody(req) as Record<string, unknown>;
      const partial: { enabled?: boolean; dayOfWeek?: number | null; hour?: number } = {};
      if (typeof body.enabled === "boolean") partial.enabled = body.enabled;
      if (body.dayOfWeek === null || typeof body.dayOfWeek === "number") partial.dayOfWeek = body.dayOfWeek;
      if (typeof body.hour === "number") partial.hour = body.hour;
      const state = await stageController.setAutoUpdate(partial);
      json(res, state);
      return;
    }
    if (method === "POST" && pathname === "/api/reconnect-schedule") {
      const body = await readBody(req) as Record<string, unknown>;
      const partial: Record<string, unknown> = {};
      if (typeof body.enabled === "boolean") partial.enabled = body.enabled;
      for (const k of ["leadMin", "tailMin", "dormantMin"]) {
        if (typeof body[k] === "number") partial[k] = body[k];
      }
      json(res, await stageController.setReconnectSchedule(partial));
      return;
    }

    // ── Config snapshot (backup / restore) ──────────────────────────────────
    // Download the full config (secrets excluded) as a .json file.
    if (method === "GET" && pathname === "/api/config/export") {
      const bundle = await configSnapshot.build();
      const fname = `stage-utility-config-${new Date().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${fname}"`,
      });
      res.end(JSON.stringify(bundle, null, 2));
      return;
    }
    // Restore an uploaded config bundle, then restart to apply.
    if (method === "POST" && pathname === "/api/config/import") {
      const body = await readBody(req) as Record<string, unknown>;
      const bundle = "bundle" in body ? body.bundle : body;
      try {
        const applied = await configSnapshot.apply(bundle);
        json(res, { ok: true, applied, restarting: true });
        scheduleRestart();
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    // List saved snapshots.
    if (method === "GET" && pathname === "/api/config/snapshots") {
      json(res, await configSnapshot.list());
      return;
    }
    // Save the current config as a named snapshot.
    if (method === "POST" && pathname === "/api/config/snapshots") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : "";
      json(res, await configSnapshot.save(name), 201);
      return;
    }
    // Recall a saved snapshot (apply + restart).
    const snapRecallMatch = pathname.match(/^\/api\/config\/snapshots\/([^/]+)\/recall$/);
    if (method === "POST" && snapRecallMatch) {
      try {
        const applied = await configSnapshot.recall(snapRecallMatch[1]);
        json(res, { ok: true, applied, restarting: true });
        scheduleRestart();
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    // Delete a saved snapshot.
    const snapDeleteMatch = pathname.match(/^\/api\/config\/snapshots\/([^/]+)$/);
    if (method === "DELETE" && snapDeleteMatch) {
      await configSnapshot.delete(snapDeleteMatch[1]);
      json(res, { ok: true });
      return;
    }

    // ── Branding (app name + logos) ─────────────────────────────────────────
    if (method === "GET" && pathname === "/api/branding/source") {
      const t = _url.searchParams.get("target");
      const target = t === "empty" ? "empty" : t === "avatar" ? "avatar" : "app";
      json(res, await stageController.getBrandingSource(target));
      return;
    }

    if (method === "POST" && pathname === "/api/branding") {
      const body = await readBody(req) as Record<string, unknown>;
      const partial: Record<string, unknown> = {};
      if (typeof body.name === "string") partial.name = body.name;
      if (typeof body.monochrome === "boolean") partial.monochrome = body.monochrome;

      // Validate a data-URL image field; cap size so it can't bloat storage.
      const validateImage = (key: "logo" | "logoOriginal" | "emptyLogo" | "emptyLogoOriginal" | "avatar" | "avatarOriginal"): boolean => {
        if (!(key in body)) return true;
        const v = body[key];
        if (v === null) {
          partial[key] = null;
          return true;
        }
        if (typeof v !== "string" || !v.startsWith("data:image/")) {
          error(res, `body.${key} must be an image data URL or null`);
          return false;
        }
        if (v.length > 2_000_000) {
          error(res, `${key} too large (max ~1.5 MB)`);
          return false;
        }
        partial[key] = v;
        return true;
      };
      if (!validateImage("logo")) return;
      if (!validateImage("logoOriginal")) return;
      if (!validateImage("emptyLogo")) return;
      if (!validateImage("emptyLogoOriginal")) return;
      if (!validateImage("avatar")) return;
      if (!validateImage("avatarOriginal")) return;

      const readCrop = (key: "logoCrop" | "emptyLogoCrop" | "avatarCrop"): void => {
        if (!(key in body)) return;
        const c = body[key] as Record<string, unknown> | null;
        partial[key] =
          c && typeof c.scale === "number" && typeof c.x === "number" && typeof c.y === "number"
            ? { scale: c.scale, x: c.x, y: c.y }
            : null;
      };
      readCrop("logoCrop");
      readCrop("emptyLogoCrop");
      readCrop("avatarCrop");

      const state = await stageController.setBranding(
        partial as Parameters<typeof stageController.setBranding>[0],
      );
      json(res, state);
      return;
    }

    // ── Presets ───────────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/presets") {
      const presets = await stageController.listPresets();
      json(res, presets);
      return;
    }

    if (method === "POST" && pathname === "/api/presets") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.name !== "string" || !(body.name as string).trim()) {
        error(res, "body.name (non-empty string) required");
        return;
      }
      // Optional displayId — defaults to primary display if omitted.
      const displayIdForPreset = typeof body.displayId === "string" ? body.displayId : "";
      const presets = await stageController.savePreset(displayIdForPreset, (body.name as string).trim());
      json(res, presets);
      return;
    }

    // POST /api/presets/import — add a preset from imported data (name + slots).
    if (method === "POST" && pathname === "/api/presets/import") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.name !== "string" || !(body.name as string).trim()) {
        error(res, "body.name (non-empty string) required");
        return;
      }
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const presets = await stageController.importPreset((body.name as string).trim(), body.slots as never[]);
      json(res, presets);
      return;
    }

    // POST /api/presets/reorder — { ids: string[] } (checked before :id routes)
    if (method === "POST" && pathname === "/api/presets/reorder") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.ids)) {
        error(res, "body.ids (array) required");
        return;
      }
      const presets = await stageController.reorderPresets(body.ids as string[]);
      json(res, presets);
      return;
    }

    // POST /api/presets/:id/apply
    const presetApplyMatch = pathname.match(/^\/api\/presets\/([^/]+)\/apply$/);
    if (method === "POST" && presetApplyMatch) {
      const id = presetApplyMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const displayIdForApply = typeof body.displayId === "string" ? body.displayId : "";
      const state = await stageController.applyPreset(displayIdForApply, id);
      json(res, state);
      return;
    }

    // PATCH /api/presets/:id — rename ({ name }) and/or overwrite ({ overwriteFromDisplayId })
    const presetPatchMatch = pathname.match(/^\/api\/presets\/([^/]+)$/);
    if (method === "PATCH" && presetPatchMatch) {
      const id = presetPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      let presets = await stageController.listPresets();
      if (typeof body.name === "string") presets = await stageController.renamePreset(id, body.name);
      // `slots` (explicit) overwrites with those directly (inline mic-slots objects);
      // otherwise overwrite from the given view/display's current slots.
      if (Array.isArray(body.slots)) {
        presets = await stageController.overwritePreset(id, "", body.slots as Slot[]);
      } else if (typeof body.overwriteFromDisplayId === "string") {
        presets = await stageController.overwritePreset(id, body.overwriteFromDisplayId);
      }
      json(res, presets);
      return;
    }

    // DELETE /api/presets/:id
    const presetDeleteMatch = pathname.match(/^\/api\/presets\/([^/]+)$/);
    if (method === "DELETE" && presetDeleteMatch) {
      const id = presetDeleteMatch[1];
      const presets = await stageController.deletePreset(id);
      json(res, presets);
      return;
    }

    // 404
    error(res, `Not found: ${method} ${pathname}`, 404);
  }
}

export const remoteServer = new RemoteServer();
