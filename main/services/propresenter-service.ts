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

import type { ProPresenterStatusDTO, ProSection, ProTimer, PropInstancesDTO, PropInstanceMeta } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";

const POLL_INTERVAL_MS = 500;
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

interface MatchGroup {
  name: string;
  colorHex: string;
  slides: { text: string; notes: string }[];
}

// Flatten the active presentation's groups in document order, keeping each
// slide's text + chord (notes). ProPresenter slides carry no stable uuid, but
// text(+notes) is enough to find which group (= section) the live slide is in —
// and matching by CONTENT is immune to arrangement reordering and non-sequential
// jumps, unlike the global slide_index (which lives in a different/expanded
// space: e.g. it reports index 49 for a 44-slide deck).
function libraryGroups(active: unknown): MatchGroup[] {
  const gs = pick(active, "presentation", "groups");
  if (!Array.isArray(gs)) return [];
  return gs.map((g) => ({
    name: asString(pick(g, "name")) ?? "",
    colorHex: colorToHex(pick(g, "color")),
    slides: Array.isArray(pick(g, "slides"))
      ? (pick(g, "slides") as unknown[]).map((s) => ({
          text: asString(pick(s, "text")) ?? "",
          notes: asString(pick(s, "notes")) ?? "",
        }))
      : [],
  }));
}

// Locate the group + cumulative slide index whose content matches `text`
// (preferring an exact text+notes match, then text-only). Returns null when the
// text is empty (e.g. a media slide) or nothing matches.
function locateSlide(
  groups: MatchGroup[],
  text: string | null,
  notes: string | null,
): { name: string; colorHex: string; groupPos: number; cumIndex: number } | null {
  if (!text) return null;
  for (const requireNotes of [true, false]) {
    let cum = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      for (let si = 0; si < g.slides.length; si++) {
        const s = g.slides[si];
        if (s.text === text && (!requireNotes || !notes || s.notes === notes)) {
          return { name: g.name, colorHex: g.colorHex, groupPos: gi, cumIndex: cum + si };
        }
      }
      cum += g.slides.length;
    }
  }
  return null;
}

// Expand the presentation into PLAY order — one entry per slide, in the order
// ProPresenter actually presents them. ProPresenter's slide_index indexes into
// THIS sequence (it can exceed the library slide count because an arrangement
// repeats groups). The arrangement's `groups` is a list of group uuids (with
// repeats) defining play order. `current_arrangement` is often left blank even
// when an arrangement is in effect, so fall back to the sole arrangement when
// there's exactly one, then to library/document order as a last resort.
function playOrderSections(active: unknown): { name: string; colorHex: string }[] {
  const groups = pick(active, "presentation", "groups");
  if (!Array.isArray(groups)) return [];

  const byUuid = new Map<string, unknown>();
  for (const g of groups) {
    const u = asString(pick(g, "uuid"));
    if (u) byUuid.set(u, g);
  }
  const expand = (g: unknown): { name: string; colorHex: string }[] => {
    const name = asString(pick(g, "name")) ?? "";
    const colorHex = colorToHex(pick(g, "color"));
    const slides = pick(g, "slides");
    const n = Array.isArray(slides) ? slides.length : 0;
    return Array.from({ length: n }, () => ({ name, colorHex }));
  };

  const arrUuid = asString(pick(active, "presentation", "current_arrangement"));
  const arrangements = pick(active, "presentation", "arrangements");
  let arr: unknown = null;
  if (Array.isArray(arrangements)) {
    if (arrUuid) arr = arrangements.find((a) => asString(pick(a, "id", "uuid")) === arrUuid) ?? null;
    if (!arr && arrangements.length === 1) arr = arrangements[0];
  }

  const refs = pick(arr, "groups");
  if (Array.isArray(refs)) {
    const out: { name: string; colorHex: string }[] = [];
    for (const u of refs) {
      const g = byUuid.get(asString(u) ?? "");
      if (g) out.push(...expand(g));
    }
    if (out.length) return out;
  }

  // No usable arrangement — present in library/document order.
  return groups.flatMap(expand);
}

class ProPresenterService {
  private host: string | null = null;
  private port: number | null = null;
  private pollMs = POLL_INTERVAL_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private last: ProPresenterStatusDTO = OFFLINE;
  private lastJson = "";
  private onConn: ((state: ProConnState, message: string | null) => void) | null = null;
  private reported: ProConnState | null = null;

  // Preview target for the /api/propresenter/thumbnail proxy.
  private activeUuid: string | null = null;
  private slideIdxZero: number | null = null;

  // Playlist item cache (items change rarely — refetch only when the playlist changes).
  private playlistUuid: string | null = null;
  private playlistItems: { name: string; index: number }[] = [];

  readonly id: string;
  private readonly channel: string;
  private onEmitCb: (() => void) | null = null;

  constructor(id = "default") {
    this.id = id;
    // The primary instance keeps the original channel so built-in views + existing
    // consumers are untouched; extra instances get a per-id channel.
    this.channel = id === "default" ? "propresenter:status" : `propresenter:status:${id}`;
  }

  setConnectionListener(cb: (state: ProConnState, message: string | null) => void): void {
    this.onConn = cb;
  }

  /** Notified after this instance's status changes — the manager uses it to
   *  rebuild + broadcast the combined `propresenter:instances` payload. */
  setEmitListener(cb: () => void): void {
    this.onEmitCb = cb;
  }

  /** Latest polled status — lets a freshly-loaded dashboard hydrate immediately
   *  (we only broadcast on change, so otherwise it'd wait for the next slide). */
  getStatus(): ProPresenterStatusDTO {
    return this.last;
  }

  private report(state: ProConnState, message: string | null): void {
    if (this.reported === state) return;
    this.reported = state;
    this.onConn?.(state, message);
  }

  configure(host: string, port: number, pollMs?: number): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    // Clamp to a sane floor so a bad setting can't hammer ProPresenter.
    this.pollMs = pollMs && pollMs >= 200 ? Math.floor(pollMs) : POLL_INTERVAL_MS;
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
    // Drop the playlist-items cache too, so a reconnect to a different (or edited)
    // service can't leak a stale "next item" from the previous playlist.
    this.playlistUuid = null;
    this.playlistItems = [];
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
      this.schedule(this.pollMs);
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

    // Resolve sections from the PLAY-ORDER position. ProPresenter's slide_index
    // indexes the arrangement-expanded play order, so play[idx] is the live
    // slide's group — exact for repeated groups AND for text-less Intro/
    // Instrumental/Outro slides (which can't be matched by content). When there's
    // no index (rare), fall back to matching the slide text against the groups.
    const play = playOrderSections(active);
    const total = play.length;
    const idxZeroRaw = asNumber(pick(slideIndex, "presentation_index", "index"));
    const idxZero =
      idxZeroRaw == null
        ? null
        : total > 0
          ? Math.min(Math.max(idxZeroRaw, 0), total - 1)
          : Math.max(idxZeroRaw, 0);

    let currentSection: ProSection | null = null;
    let nextSection: ProSection | null = null;
    let nextArrangementSection: ProSection | null = null;

    if (idxZero != null && total > 0) {
      const cur = play[idxZero];
      if (cur?.name) currentSection = { name: cur.name, colorHex: cur.colorHex };
      const nxt = play[idxZero + 1];
      if (nxt?.name) nextSection = { name: nxt.name, colorHex: nxt.colorHex };
      // "Then": next differently-named group later in the play order.
      for (let i = idxZero + 1; i < total; i++) {
        if (play[i].name && play[i].name !== currentSection?.name) {
          nextArrangementSection = { name: play[i].name, colorHex: play[i].colorHex };
          break;
        }
      }
    } else {
      const groups = libraryGroups(active);
      const curLoc = locateSlide(groups, currentSlideText, currentNotes);
      const nextLoc = locateSlide(groups, nextSlideText, nextNotes);
      if (curLoc?.name) currentSection = { name: curLoc.name, colorHex: curLoc.colorHex };
      if (nextLoc?.name) nextSection = { name: nextLoc.name, colorHex: nextLoc.colorHex };
    }

    const idx = idxZero == null ? null : idxZero + 1;
    const slideCount = total > 0 ? total : null;
    const slidesRemaining =
      idx != null && slideCount != null ? Math.max(0, slideCount - idx) : null;

    if (process.env.PP_DEBUG) {
      console.log(
        `[propresenter] rawIdx=${idxZeroRaw}→${idxZero}/${total} ` +
          `section=${JSON.stringify(currentSection?.name ?? null)} ` +
          `next=${JSON.stringify(nextSection?.name ?? null)} ` +
          `curText=${JSON.stringify((currentSlideText ?? "").slice(0, 24))}`,
      );
    }

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
    // The key includes the current arrangement so that reordering a song (same
    // presentation uuid + same index, but a different slide there) still busts the
    // <img> cache and refetches the live thumbnail.
    // The thumbnail proxy fetches by ProPresenter's own slide index, so keep the
    // RAW index here (not the content-matched counter). The key also includes the
    // arrangement so a live reorder busts the <img> cache.
    const arrUuid = asString(pick(active, "presentation", "current_arrangement"));
    this.activeUuid = asString(pick(active, "presentation", "id", "uuid"));
    this.slideIdxZero = idxZeroRaw;
    const slidePreviewKey =
      this.activeUuid && idxZeroRaw != null
        ? `${this.activeUuid}:${arrUuid ?? ""}:${idxZeroRaw}`
        : null;

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
    // Only push when something actually changed — at 2 Hz an unchanged broadcast
    // would re-render every dashboard for nothing.
    const json = JSON.stringify(status);
    if (json === this.lastJson) return;
    this.lastJson = json;
    broadcast(this.channel, status);
    this.onEmitCb?.();
  }
}

export const propresenterService = new ProPresenterService("default");

// ── Multi-instance manager ────────────────────────────────────────────────────
// The church runs two auditoriums, each with its own ProPresenter machine. The
// PRIMARY instance stays `propresenterService` (channel "propresenter:status",
// unchanged for built-in views); EXTRA instances are managed here, each on its
// own channel. A combined snapshot (all instances + their status) is broadcast on
// "propresenter:instances" so a custom layout object can pick which one it reads.

export interface PropInstanceConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  pollMs?: number;
  enabled?: boolean;
}

class ProPresenterManager {
  private extras = new Map<string, ProPresenterService>();
  private names = new Map<string, string>(); // id → display name (incl. "default")
  private defaultName = "Main";

  init(): void {
    propresenterService.setEmitListener(() => this.broadcastCombined());
  }

  /** Reconcile the extra instances to `extras`; `defaultName` names the primary.
   *  Pass an empty `extras` list to tear them all down (integration disabled). */
  apply(defaultName: string | null, extras: PropInstanceConfig[]): void {
    this.defaultName = defaultName?.trim() || "Main";
    const wanted = new Set(extras.map((e) => e.id));
    for (const [id, svc] of this.extras) {
      if (!wanted.has(id)) {
        svc.stop();
        this.extras.delete(id);
        this.names.delete(id);
      }
    }
    for (const e of extras) {
      let svc = this.extras.get(e.id);
      if (!svc) {
        svc = new ProPresenterService(e.id);
        svc.setEmitListener(() => this.broadcastCombined());
        this.extras.set(e.id, svc);
      }
      this.names.set(e.id, e.name?.trim() || e.id);
      if (e.enabled !== false && e.host && e.port > 0) svc.configure(e.host, e.port, e.pollMs);
      else svc.stop();
    }
    this.broadcastCombined();
  }

  private broadcastCombined(): void {
    broadcast("propresenter:instances", this.getInstancesDto());
  }

  getInstancesDto(): PropInstancesDTO {
    const list: PropInstanceMeta[] = [
      { id: "default", name: this.defaultName },
      ...[...this.extras.keys()].map((id) => ({ id, name: this.names.get(id) ?? id })),
    ];
    const status: Record<string, ProPresenterStatusDTO> = {
      default: propresenterService.getStatus(),
    };
    for (const [id, svc] of this.extras) status[id] = svc.getStatus();
    return { list, status };
  }

  /** Thumbnail target for a given instance ("default"/empty → primary). */
  getThumbnailTarget(id: string | null | undefined) {
    if (!id || id === "default") return propresenterService.getThumbnailTarget();
    return this.extras.get(id)?.getThumbnailTarget() ?? null;
  }
}

export const propresenterManager = new ProPresenterManager();
