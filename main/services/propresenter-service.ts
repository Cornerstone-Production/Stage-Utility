// propresenter-service.ts — Reads live status from ProPresenter 7.9+ via its
// official local HTTP API (LAN, no auth) and broadcasts it on "propresenter:status"
// for the dashboard display.
//
// We poll a few REST endpoints once per second while connected (simpler and more
// robust than the chunked-streaming variant; 1s latency is fine for a stage
// dashboard, and a LAN poll is cheap). Connect/poll/reconnect lifecycle mirrors
// the wireless providers.
//
// IMPORTANT: the exact JSON field spellings of the ProPresenter API can vary
// slightly by point-release. Extraction is centralised in `buildStatus()` and
// written defensively (every field degrades to null), so an unexpected shape
// shows blanks on the dashboard rather than crashing. Tune the field paths there
// against a live instance if any value reads blank (see /v1 docs on the device:
// ProPresenter → Settings → Network → "API Documentation").

import * as http from "http";

import type { ProPresenterStatusDTO } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";

const POLL_INTERVAL_MS = 1000;
const ERROR_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;

const OFFLINE: ProPresenterStatusDTO = {
  connected: false,
  currentItem: null,
  nextItem: null,
  slideIndex: null,
  slideCount: null,
  slidesRemaining: null,
};

// Reported to the IntegrationManager so the Integrations card badge reflects
// reachability (separate from the "propresenter:status" data channel).
type ProConnState = "connected" | "error" | "disconnected";

function getJson(host: string, port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 400) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// Safe nested getter: pick(obj, "a", "b") → obj?.a?.b (unknown-typed).
function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

class ProPresenterService {
  private host: string | null = null;
  private port: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private last: ProPresenterStatusDTO = OFFLINE;
  private onConn: ((state: ProConnState, message: string | null) => void) | null = null;
  private reported: ProConnState | null = null;

  /** Subscribe to connection-state changes (for the Integrations card badge). */
  setConnectionListener(cb: (state: ProConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  private report(state: ProConnState, message: string | null): void {
    if (this.reported === state) return;
    this.reported = state;
    this.onConn?.(state, message);
  }

  /** Point at a ProPresenter instance and (re)start polling. */
  configure(host: string, port: number): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.reported = null; // force a fresh connected/error report
    this.restart();
  }

  start(): void {
    if (this.running || !this.host || !this.port) return;
    this.running = true;
    console.log(`[propresenter] polling ${this.host}:${this.port}`);
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.last.connected) this.emit(OFFLINE);
  }

  private restart(): void {
    this.stop();
    if (this.host && this.port) this.start();
  }

  /** One-shot connectivity check for the Integrations "Test connection" button. */
  async test(host: string, port: number): Promise<{ ok: boolean; message?: string }> {
    try {
      const version = await getJson(host, port, "/version");
      const desc = asString(pick(version, "host_description")) ?? asString(pick(version, "name"));
      return { ok: true, message: `Connected to ${desc ?? "ProPresenter"}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    const host = this.host;
    const port = this.port;
    try {
      // Connectivity probe — determines the card badge. Throws (→ error path) if
      // ProPresenter is unreachable; the data fetches below degrade to null
      // independently so a missing field never looks like a disconnect.
      await getJson(host, port, "/version");

      // active = name + groups (→ slide count); slide = current/next text;
      // slideIndex = current 0-based position. All degrade to null on their own.
      const [active, slide, slideIndex] = await Promise.all([
        getJson(host, port, "/v1/presentation/active").catch(() => null),
        getJson(host, port, "/v1/status/slide").catch(() => null),
        getJson(host, port, "/v1/presentation/slide_index").catch(() => null),
      ]);

      this.emit(this.buildStatus(active, slide, slideIndex));
      this.report("connected", `Connected to ${host}:${port}`);
      this.schedule(POLL_INTERVAL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[propresenter] poll error:", msg);
      if (this.last.connected) this.emit(OFFLINE);
      this.report("error", `Can't reach ${host}:${port} — ${msg}`);
      this.schedule(ERROR_INTERVAL_MS);
    }
  }

  // Centralised field extraction, verified against ProPresenter 21.3 (API v1).
  //   active      = GET /v1/presentation/active
  //   slide       = GET /v1/status/slide
  //   slideIndex  = GET /v1/presentation/slide_index
  // Defensive (every field degrades to null) so an unexpected shape on another
  // version shows blanks rather than crashing.
  private buildStatus(active: unknown, slide: unknown, slideIndex: unknown): ProPresenterStatusDTO {
    // Current item = active presentation name (lives at presentation.id.name).
    const currentItem =
      asString(pick(active, "presentation", "id", "name")) ??
      asString(pick(active, "presentation", "name"));

    // Next item = next slide's text.
    const nextItem = asString(pick(slide, "next", "text"));

    // Current slide index — 0-based at presentation_index.index → make it 1-based.
    const idxZero = asNumber(pick(slideIndex, "presentation_index", "index"));
    const idx = idxZero == null ? null : idxZero + 1;

    // Total slides = sum of slides across all groups in the active presentation.
    const groups = pick(active, "presentation", "groups");
    const slideCount = Array.isArray(groups)
      ? groups.reduce((sum: number, g: unknown) => {
          const slides = pick(g, "slides");
          return sum + (Array.isArray(slides) ? slides.length : 0);
        }, 0)
      : null;

    const slidesRemaining =
      idx != null && slideCount != null ? Math.max(0, slideCount - idx) : null;

    return {
      connected: true,
      currentItem,
      nextItem,
      slideIndex: idx,
      slideCount,
      slidesRemaining,
    };
  }

  private emit(status: ProPresenterStatusDTO): void {
    this.last = status;
    broadcast("propresenter:status", status);
  }
}

export const propresenterService = new ProPresenterService();
