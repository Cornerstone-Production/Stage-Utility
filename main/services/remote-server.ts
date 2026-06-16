// LAN HTTP server on port 8788.
// Serves public/control.html at GET / and the /api/* endpoints.
// Permissive CORS on /api/*. Tracks sockets for clean shutdown.

import * as fs from "fs/promises";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import type { DisplayKind, Slot } from "../types/stage.js";
import { addBroadcastListener } from "./broadcaster.js";
import { deviceManager } from "./device-manager.js";
import { integrationManager } from "./integration-manager.js";
import { prodcomService } from "./prodcom-service.js";
import { propresenterService, THUMBNAIL_QUALITY as PROPRESENTER_THUMBNAIL_QUALITY } from "./propresenter-service.js";
import { stageController } from "./stage-controller.js";
import { wirelessManager } from "./wireless-manager.js";

// ── Static renderer build path candidates ──────────────────────────────────────
// In standalone mode the renderer is built to build/renderer/ relative to cwd.
const RENDERER_BUILD_DIR = path.join(process.cwd(), "build", "renderer");

const PORT = 8788;

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

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

function isDisplayKind(v: unknown): v is DisplayKind {
  return v === "slots" || v === "dashboard" || v === "stage" || v === "transcription";
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

function sseWrite(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class RemoteServer {
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();

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
  private async tryServeStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
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
        "application/octet-stream";
      const data = await fs.readFile(candidate);
      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
      return true;
    } catch {
      // File not found — fall through
    }

    // SPA fallback: for HTML-like routes (no extension), serve index.html
    if (!path.extname(urlPath)) {
      const fallback = path.join(RENDERER_BUILD_DIR, "index.html");
      try {
        const html = await fs.readFile(fallback, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
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
    addBroadcastListener((channel, payload) => {
      for (const client of sseClients) {
        try {
          sseWrite(client, channel, payload);
        } catch {
          sseClients.delete(client);
        }
      }
    });

    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const pathname = url.pathname;

      console.log(`[remote-server] ${req.method} ${pathname}`);

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
    });

    this.server.on("connection", (socket: net.Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(PORT, "0.0.0.0", () => {
        console.log(`[remote-server] listening on 0.0.0.0:${PORT} (LAN: ${this.getLanUrl()})`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    console.log("[remote-server] stopping");
    // Force-close all tracked sockets so the server shuts down promptly.
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

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
    // ── Serve renderer static build (standalone mode) ─────────────────────
    // Serves the Vite-built renderer from build/renderer/ when it exists.
    if (method === "GET" && !pathname.startsWith("/api/") && pathname !== "/photos") {
      const staticServed = await this.tryServeStatic(pathname, res);
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
      // Send initial state snapshot so the client is immediately in sync.
      sseWrite(res, "stage:state-changed", stageController.getState());
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
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
      const target = propresenterService.getThumbnailTarget();
      if (!target) {
        res.writeHead(503);
        res.end("ProPresenter not connected / no active slide");
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
        res.writeHead(200, {
          "Content-Type": up.headers["content-type"] ?? "image/jpeg",
          "Cache-Control": "no-store",
        });
        up.pipe(res);
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
    if (method === "GET" && pathname === "/api/health") {
      json(res, { ok: true });
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

    // PATCH /api/displays/:id — accepts { name? } and/or { kind? }
    const displayPatchMatch = pathname.match(/^\/api\/displays\/([^/]+)$/);
    if (method === "PATCH" && displayPatchMatch) {
      const id = displayPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const hasName = typeof body.name === "string";
      const hasKind = isDisplayKind(body.kind);
      if (!hasName && !hasKind) {
        error(res, "body.name (string) or body.kind ('slots'|'dashboard'|'stage') required");
        return;
      }
      let state = stageController.getState();
      if (hasName) state = await stageController.renameDisplay(id, body.name as string);
      if (hasKind) state = await stageController.setDisplayKind(id, body.kind as DisplayKind);
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

    // ── Branding (app name + logos) ─────────────────────────────────────────
    if (method === "GET" && pathname === "/api/branding/source") {
      const target = _url.searchParams.get("target") === "empty" ? "empty" : "app";
      json(res, await stageController.getBrandingSource(target));
      return;
    }

    if (method === "POST" && pathname === "/api/branding") {
      const body = await readBody(req) as Record<string, unknown>;
      const partial: Record<string, unknown> = {};
      if (typeof body.name === "string") partial.name = body.name;
      if (typeof body.monochrome === "boolean") partial.monochrome = body.monochrome;

      // Validate a data-URL image field; cap size so it can't bloat storage.
      const validateImage = (key: "logo" | "logoOriginal" | "emptyLogo" | "emptyLogoOriginal"): boolean => {
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

      const readCrop = (key: "logoCrop" | "emptyLogoCrop"): void => {
        if (!(key in body)) return;
        const c = body[key] as Record<string, unknown> | null;
        partial[key] =
          c && typeof c.scale === "number" && typeof c.x === "number" && typeof c.y === "number"
            ? { scale: c.scale, x: c.x, y: c.y }
            : null;
      };
      readCrop("logoCrop");
      readCrop("emptyLogoCrop");

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
