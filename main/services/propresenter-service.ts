// propresenter-service.ts — Reads live status from ProPresenter 7.9+ via its
// official local HTTP API (LAN, no auth) and broadcasts it on "propresenter:status"
// for the dashboard + stage displays.
//
// Polls a few REST endpoints once per second while connected (simpler/robust vs
// chunked streaming; 1s latency is fine and a LAN poll is cheap). Connect/poll/
// reconnect lifecycle mirrors the wireless providers.
//
// Field paths are verified against ProPresenter 21.3 (API v1) but written
// defensively (every field degrades to null), so a different point-release shows
// blanks rather than crashing. Tune in buildStatus()/sectionsFor() if anything
// reads blank (device shows exact shapes at Settings → Network → API Documentation).

import * as http from "http";

import type { ProPresenterStatusDTO, ProSection, ProTimer } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";

const POLL_INTERVAL_MS = 1000;
const ERROR_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;
/** Thumbnail width requested from ProPresenter (px). */
export const THUMBNAIL_QUALITY = 400;

const OFFLINE: ProPresenterStatusDTO = {
  connected: false,
  currentItem: null,
  nextItem: null,
  slideIndex: null,
  slideCount: null,
  slidesRemaining: null,
  currentSlideText: null,
  nextSlideText: null,
  currentNotes: null,
  nextNotes: null,
  currentSection: null,
  nextSection: null,
  nextArrangementSection: null,
  currentServiceItem: null,
  nextServiceItem: null,
  timers: [],
  slidePreviewKey: null,
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

// ProPresenter group color is rgba with 0–1 channels → "#rrggbb".
function colorToHex(color: unknown): string {
  const c = (n: unknown) => Math.max(0, Math.min(255, Math.round((asNumber(n) ?? 0) * 255)));
  const r = c(pick(color, "red"));
  const g = c(pick(color, "green"));
  const b = c(pick(color, "blue"));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

interface OrderedGroup {
  name: string;
  colorHex: string;
  slideCount: number;
}

// Build the play-order group sequence from the active presentation, honoring the
// current arrangement (groups referenced by uuid, in order) when one is set;
// otherwise the library group order. Returns the flattened sequence + total slides.
function orderedGroups(active: unknown): { seq: OrderedGroup[]; total: number } {
  const libGroups = pick(active, "presentation", "groups");
  if (!Array.isArray(libGroups)) return { seq: [], total: 0 };

  const toOrdered = (g: unknown): OrderedGroup => ({
    name: asString(pick(g, "name")) ?? "",
    colorHex: colorToHex(pick(g, "color")),
    slideCount: Array.isArray(pick(g, "slides")) ? (pick(g, "slides") as unknown[]).length : 0,
  });

  const arrUuid = asString(pick(active, "presentation", "current_arrangement"));
  let seq: OrderedGroup[];
  if (arrUuid) {
    const arrangements = pick(active, "presentation", "arrangements");
    const arr = Array.isArray(arrangements)
      ? arrangements.find((a) => asString(pick(a, "id", "uuid")) === arrUuid)
      : null;
    const groupUuids = pick(arr, "groups");
    const byUuid = new Map<string, unknown>();
    for (const g of libGroups) {
      const u = asString(pick(g, "uuid"));
      if (u) byUuid.set(u, g);
    }
    seq = Array.isArray(groupUuids)
      ? groupUuids.map((u) => byUuid.get(asString(u) ?? "")).filter(Boolean).map(toOrdered)
      : libGroups.map(toOrdered);
  } else {
    seq = libGroups.map(toOrdered);
  }

  const total = seq.reduce((sum, g) => sum + g.slideCount, 0);
  return { seq, total };
}

// Resolve which section a flattened 0-based slide index falls in.
function sectionAt(seq: OrderedGroup[], index: number): { section: ProSection | null; groupPos: number } {
  let acc = 0;
  for (let i = 0; i < seq.length; i++) {
    const g = seq[i];
    if (index < acc + g.slideCount) {
      return { section: g.name ? { name: g.name, colorHex: g.colorHex } : null, groupPos: i };
    }
    acc += g.slideCount;
  }
  return { section: null, groupPos: -1 };
}

class ProPresenterService {
  private host: string | null = null;
  private port: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private last: ProPresenterStatusDTO = OFFLINE;
  private onConn: ((state: ProConnState, message: string | null) => void) | null = null;
  private reported: ProConnState | null = null;

  // Preview target for the /api/propresenter/thumbnail proxy.
  private activeUuid: string | null = null;
  private slideIdxZero: number | null = null;

  // Playlist item cache (items change rarely — refetch only when the playlist changes).
  private playlistUuid: string | null = null;
  private playlistItems: { name: string; index: number }[] = [];

  setConnectionListener(cb: (state: ProConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  private report(state: ProConnState, message: string | null): void {
    if (this.reported === state) return;
    this.reported = state;
    this.onConn?.(state, message);
  }

  configure(host: string, port: number): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.reported = null;
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
    this.activeUuid = null;
    this.slideIdxZero = null;
    if (this.last.connected) this.emit(OFFLINE);
  }

  private restart(): void {
    this.stop();
    if (this.host && this.port) this.start();
  }

  /** Current thumbnail source for the proxy route, or null when unavailable. */
  getThumbnailTarget(): { host: string; port: number; uuid: string; index: number } | null {
    if (!this.host || !this.port || !this.activeUuid || this.slideIdxZero == null) return null;
    return { host: this.host, port: this.port, uuid: this.activeUuid, index: this.slideIdxZero };
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
      // Connectivity probe — gates the card badge. Data fetches below degrade to
      // null independently so a missing field never looks like a disconnect.
      await getJson(host, port, "/version");

      const [active, slide, slideIndex, playlistActive, timers] = await Promise.all([
        getJson(host, port, "/v1/presentation/active").catch(() => null),
        getJson(host, port, "/v1/status/slide").catch(() => null),
        getJson(host, port, "/v1/presentation/slide_index").catch(() => null),
        getJson(host, port, "/v1/playlist/active").catch(() => null),
        getJson(host, port, "/v1/timers/current").catch(() => null),
      ]);

      const services = await this.resolveServiceItems(host, port, playlistActive);

      this.emit(this.buildStatus(active, slide, slideIndex, services, timers));
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

  // Current + next service (playlist) item names. Caches the items list and only
  // re-fetches /v1/playlist/{uuid} when the active playlist changes.
  private async resolveServiceItems(
    host: string,
    port: number,
    playlistActive: unknown,
  ): Promise<{ current: string | null; next: string | null }> {
    const pUuid = asString(pick(playlistActive, "presentation", "playlist", "uuid"));
    const curName = asString(pick(playlistActive, "presentation", "item", "name"));
    const curIndex = asNumber(pick(playlistActive, "presentation", "item", "index"));
    if (!pUuid) return { current: curName, next: null };

    if (pUuid !== this.playlistUuid) {
      try {
        const pl = await getJson(host, port, `/v1/playlist/${pUuid}`);
        const items = pick(pl, "items");
        this.playlistItems = Array.isArray(items)
          ? items
              .map((it) => ({
                name: asString(pick(it, "id", "name")) ?? "",
                index: asNumber(pick(it, "id", "index")) ?? -1,
              }))
              .filter((it) => it.name)
          : [];
        this.playlistUuid = pUuid;
      } catch {
        this.playlistItems = [];
      }
    }

    let next: string | null = null;
    if (curIndex != null) {
      next = this.playlistItems.find((it) => it.index === curIndex + 1)?.name ?? null;
    }
    return { current: curName, next };
  }

  private buildStatus(
    active: unknown,
    slide: unknown,
    slideIndex: unknown,
    services: { current: string | null; next: string | null },
    timers: unknown,
  ): ProPresenterStatusDTO {
    const currentItem =
      asString(pick(active, "presentation", "id", "name")) ??
      asString(pick(active, "presentation", "name"));

    const currentSlideText = asString(pick(slide, "current", "text"));
    const nextSlideText = asString(pick(slide, "next", "text"));
    const currentNotes = asString(pick(slide, "current", "notes"));
    const nextNotes = asString(pick(slide, "next", "notes"));

    const idxZero = asNumber(pick(slideIndex, "presentation_index", "index"));
    const idx = idxZero == null ? null : idxZero + 1;

    // Sections via the arrangement-aware play order.
    const { seq, total } = orderedGroups(active);
    let currentSection: ProSection | null = null;
    let nextSection: ProSection | null = null;
    let nextArrangementSection: ProSection | null = null;
    if (idxZero != null && seq.length) {
      const cur = sectionAt(seq, idxZero);
      currentSection = cur.section;
      nextSection = sectionAt(seq, idxZero + 1).section;
      // Next *different* group after the current group's position.
      for (let i = cur.groupPos + 1; i < seq.length; i++) {
        if (seq[i].name && seq[i].name !== currentSection?.name) {
          nextArrangementSection = { name: seq[i].name, colorHex: seq[i].colorHex };
          break;
        }
      }
    }

    const slideCount = total > 0 ? total : null;
    const slidesRemaining =
      idx != null && slideCount != null ? Math.max(0, slideCount - idx) : null;

    // Running named timers (state ≠ "stopped").
    const runningTimers: ProTimer[] = Array.isArray(timers)
      ? timers
          .map((t) => ({
            name: asString(pick(t, "id", "name")) ?? "Timer",
            time: asString(pick(t, "time")) ?? "",
            state: asString(pick(t, "state")) ?? "",
          }))
          .filter((t) => t.state && t.state !== "stopped")
      : [];

    // Stash preview target + key (thumbnail index is the 0-based slide index).
    this.activeUuid = asString(pick(active, "presentation", "id", "uuid"));
    this.slideIdxZero = idxZero;
    const slidePreviewKey =
      this.activeUuid && idxZero != null ? `${this.activeUuid}:${idxZero}` : null;

    return {
      connected: true,
      currentItem,
      nextItem: nextSlideText,
      slideIndex: idx,
      slideCount,
      slidesRemaining,
      currentSlideText,
      nextSlideText,
      currentNotes,
      nextNotes,
      currentSection,
      nextSection,
      nextArrangementSection,
      currentServiceItem: services.current,
      nextServiceItem: services.next,
      timers: runningTimers,
      slidePreviewKey,
    };
  }

  private emit(status: ProPresenterStatusDTO): void {
    this.last = status;
    broadcast("propresenter:status", status);
  }
}

export const propresenterService = new ProPresenterService();
