// propresenter-service.ts — Reads live status from ProPresenter 7.9+ via its
// official local HTTP API (LAN, no auth) and broadcasts it on "propresenter:status"
// for the dashboard + stage displays.
//
// Holds ONE server-sent-event stream per instance rather than polling. The old
// shape was six requests per cycle (`/version` plus five reads, plus a sixth when
// the playlist changed) against every configured machine: with two auditoriums,
// one at 500ms and one at 1000ms, roughly 18 requests a second all week, and
// slide latency of up to a poll interval. `POST /v1/status/updates?sse` replaces
// all of it — a snapshot frame per endpoint on subscribe, then a frame when one
// changes, and no requests at all in between.
//
// The one poll left is the FALLBACK (see `streamFallback`): `status/updates`
// needs a ProPresenter far below the one this is verified against, but a hard
// dependency on it would turn an unexpected version into an outage.
//
// Field paths are verified against ProPresenter 21.3 (API v1) but written
// defensively (every field degrades to null), so a different point-release shows
// blanks rather than crashing. Tune in buildStatus()/sectionsFor() if anything
// reads blank (device shows exact shapes at Settings → Network → API Documentation).
//
// It also WRITES, in exactly one place: `triggerMacro` runs an operator's own
// ProPresenter macro for the `propresenter.macro` automation action. Nothing else
// here sends anything ProPresenter acts on.

import { clamp } from "./clamp.js";
import { errorMessage, fetchFailureMessage } from "./errors.js";
import * as http from "http";

import type { ProPresenterStatusDTO, ProSection, ProTimer, PropInstancesDTO, PropInstanceMeta, PropInstanceConn } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { StatusIntegration } from "./integration-base.js";
import { createSseReader, keepSocketAlive } from "./sse-reader.js";

const POLL_INTERVAL_MS = 1000; // fallback poll only — see streamFallback
// Reconnect back-off when the machine is unreachable (off for the week, etc.): start
// at 5s and double, clamped by the service-window scheduler (≤2 min in/near a service,
// stretched toward the idle ceiling otherwise). Resets once the stream delivers data.
const ERROR_BASE_MS = 5000;
// FALLBACK POLL ONLY. When no client is watching this instance's channel, the poll
// drops to a slow keepalive instead of hammering 6 requests/sec. The STREAM has no
// such gate — see the note above subscribe().
const IDLE_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;

/**
 * The endpoints one subscription carries, and the order they are asked for.
 *
 * `timer/system_time` earns its place by ticking once a second whether or not
 * anything on stage moves: it is the heartbeat the silence watchdog below counts,
 * and without it a stream of only slow-changing endpoints is indistinguishable
 * from a dead one during a sermon.
 */
const STREAM_ENDPOINTS = [
  "status/slide",
  "presentation/slide_index",
  "presentation/active",
  "playlist/active",
  "timers/current",
  "timer/system_time",
] as const;

/**
 * How long the six snapshot frames (or a slide's two) are allowed to gather
 * before one DTO is published.
 *
 * A slide advance is `status/slide` AND `presentation/slide_index`, sent as two
 * frames; publishing between them broadcasts new text against the old index, and
 * because the channel is change-driven that mismatched frame really does reach
 * every display. Short enough to be imperceptible next to the poll interval it
 * replaces, which was 500-1000ms.
 */
const PUBLISH_COALESCE_MS = 20;

/**
 * How often TCP probes the peer once the stream goes quiet.
 *
 * The primary liveness check, and the reason it is not an application timer: a
 * half-open socket — the booth Mac unplugged, its switch port dropped — emits
 * neither 'end' nor 'error', so no reconnect is ever scheduled and the stage
 * display keeps showing the slide from before the drop for the rest of the
 * service. This file has made the neighbouring mistake before: a timeout sat on
 * test() while the long-lived path had none.
 */
const SOCKET_KEEPALIVE_MS = 30_000;

/**
 * Backstop for what keepalive is slow to see: fifteen missed heartbeats.
 *
 * Safe ONLY because `timer/system_time` is subscribed and ticks at 1Hz — a
 * silence watchdog over a set of slow-changing endpoints would fire during every
 * quiet stretch and reconnect all week. A false trip costs one re-subscribe and
 * blanks nothing; a missed dead stream costs the rest of the service, so the
 * threshold leans tight.
 */
const STREAM_IDLE_MS = 15_000;

/**
 * Buffer cap for this stream, four times the shared default.
 *
 * `presentation/active` carries the whole document — every group, slide, note and
 * arrangement — and the shared reader drops an unterminated run once it passes
 * the cap, so a document larger than this one would silently lose the frame that
 * drives sections, slide count and progress. A five-section worship song measured
 * 14,305 bytes on ProPresenter 21.3; a sermon deck is the untested worst case, so
 * the cap is set at ~70x the measurement rather than the 18x the 256,000 default
 * would give. The cost of the headroom is a transient megabyte in a process that
 * stays up for weeks; the cost of being under is a blank panel nobody can explain.
 */
const STREAM_MAX_BUFFER = 1_000_000;

/**
 * How long a playlist that could not be read waits before it is asked for again,
 * doubling to a ceiling.
 *
 * `/v1/playlist/<uuid>` answers 404 for a Planning Center linked playlist, so
 * this is the ordinary case here rather than an outage. Thirty seconds is short
 * enough that an operator who fixes the playlist mid-service sees the "next item"
 * name come back within a song, and the ceiling keeps a permanently-404ing one to
 * six reads an hour instead of one per frame.
 */
const PLAYLIST_RETRY_BASE_MS = 30_000;
const PLAYLIST_RETRY_MAX_MS = 10 * 60_000;
// The macro list is asked for every time the rule editor opens, once per
// configured instance, and it changes only when somebody edits ProPresenter.
// Thirty seconds rather than the Companion export's five minutes: that list has
// a Refresh button and this one does not, so a macro added mid-setup has to show
// up on the next open rather than after a coffee break.
const MACRO_CACHE_MS = 30_000;
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

/**
 * One request whose BODY does not matter — resolves ProPresenter's status code.
 *
 * Sibling of getJson rather than a second HTTP client: same `http.get`, same
 * timeout, same rejection on a transport failure. It exists because getJson
 * rejects everything >= 400 with the same `HTTP <n>` Error, and a 404 from
 * `/v1/macro/<name>/trigger` is the ONE status worth telling apart — it means
 * the macro was renamed or deleted, which is the failure that actually happens
 * months later.
 */
function getStatusCode(host: string, port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      res.resume(); // drain, so the socket is freed rather than held open
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** What a macro trigger did, or why it did nothing. Never thrown — returned. */
export interface MacroResult {
  ok: boolean;
  detail: string;
}

/**
 * One instance's macro names, and why they are missing when they are.
 *
 * Both halves, because the union across instances CAN partially fail: a booth
 * machine that is off must not make its macros look deleted without anyone
 * being told. The caller decides what to do with `error` — the option route
 * still answers with a list, because the rule editor has to open.
 */
export interface MacroListResult {
  names: string[];
  error: string | null;
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
  const c = (n: unknown) => clamp(Math.round((asNumber(n) ?? 0) * 255), 0, 255);
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

/**
 * What `POST /v1/status/updates?sse` did.
 *
 * Three cases and not a boolean, because they want three different things:
 * hold the stream, fall back to polling for good, or back off and re-dial. A
 * two-state answer is how "this ProPresenter is too old" and "the machine just
 * went away" end up sharing a code path, and one of those must not be permanent.
 */
type SubscribeOutcome =
  | { kind: "streaming" }
  | { kind: "unsupported"; status: number }
  | { kind: "failed"; error: Error };

/**
 * An SSE event name reduced to the endpoint it reports on, or null.
 *
 * Tolerates the leading slash that four of the six frames carry and the two
 * `presentation/*` ones do not, and the `vN/` the `?sse` framing prepends and
 * the chunked-JSON framing omits. See handleStreamEvent for the captured names.
 */
function streamEndpointOf(name: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\/?(?:v\d+\/)?/, "") || null;
}

class ProPresenterService extends StatusIntegration<ProPresenterStatusDTO> {
  private host: string | null = null;
  private port: number | null = null;
  private pollMs = POLL_INTERVAL_MS;
  private lastJson = "";

  // Preview target for the /api/propresenter/thumbnail proxy.
  private activeUuid: string | null = null;
  private slideIdxZero: number | null = null;

  // Macro-name cache, per instance. See listMacros.
  private macroCache: { at: number; names: string[] } | null = null;

  // Playlist item cache (items change rarely — refetch only when the playlist
  // changes, or when a recorded failure comes due). See resolveServiceItems.
  private playlistUuid: string | null = null;
  private playlistItems: { name: string; index: number }[] = [];
  private playlistRetryAt = 0;
  private playlistFailures = 0;

  /**
   * Latest frame per subscribed endpoint. buildStatus() takes exactly these five
   * — the poll used to hand it the results of five parallel GETs, and it now gets
   * the last thing the stream said instead, which is the same data one frame
   * fresher. `timer/system_time` is deliberately absent: it feeds the watchdog
   * and contributes nothing to the DTO, so a heartbeat must not cost a rebuild.
   */
  private frames: {
    active: unknown;
    slide: unknown;
    slideIndex: unknown;
    playlistActive: unknown;
    timers: unknown;
  } = { active: null, slide: null, slideIndex: null, playlistActive: null, timers: null };

  /** The held response, so teardown can hang up on it. */
  private stream: http.IncomingMessage | null = null;
  private req: http.ClientRequest | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Which run of this instance is current. Bumped by stop(), captured at the top
   * of every async method, and re-checked after EVERY await in place of
   * `running`.
   *
   * `running` is not sufficient and never was. configure() calls restart(),
   * which is `stop(); start()` SYNCHRONOUSLY, so `running` goes false and back to
   * true inside one tick: a connect() parked on the /version round trip resumes,
   * sees `running === true`, and subscribes with the host and port it captured
   * before the reconfigure. subscribe() then overwrites `stream` and `req`, and
   * whichever assignment loses is never destroyed — closeStream() only knows the
   * last pair — so a second stream is held open on the booth machine for the life
   * of the process with its data handler still feeding the same frame buffer. The
   * manager calls configure() on every settings write, a bare poll-interval
   * change included, so the window is one HTTP round trip wide and reachable.
   *
   * A counter rather than a boolean because the question is "is this still MY
   * run", which a flag that has been set back to true cannot answer.
   */
  private epoch = 0;
  /** True while publish() is inside the playlist fetch; see publishSerially. */
  private publishing = false;
  /** A frame landed while a publish was in flight — run one more when it ends. */
  private publishAgain = false;
  /** Endpoints already reported unreadable on THIS stream. Cleared with the
   *  stream, so a re-dial that hits the same schema says so again once. */
  private unreadable = new Set<string>();
  /** Set once this instance's ProPresenter refuses the subscription; see connect(). */
  private streamFallback = false;
  /** Last delay handed to scheduleIn — the reconnect log line needs the number
   *  the base class computed, and duplicating that expression here is how two
   *  copies of a back-off drift apart. */
  private nextDelayMs = 0;
  /** STREAM_IDLE_MS, as an instance field so a test can shorten it rather than
   *  spend fifteen seconds proving the watchdog fires. */
  private streamIdleMs = STREAM_IDLE_MS;
  /** PLAYLIST_RETRY_BASE_MS and PLAYLIST_RETRY_MAX_MS, for the same reason: the
   *  doubling and the ceiling are only observable by letting real deadlines
   *  elapse, and at the shipped numbers that is thirty minutes of waiting. A
   *  test that writes `playlistRetryAt` itself instead exercises the consumer
   *  and leaves the line that SETS the deadline unguarded. */
  private playlistRetryBaseMs = PLAYLIST_RETRY_BASE_MS;
  private playlistRetryMaxMs = PLAYLIST_RETRY_MAX_MS;

  readonly id: string;
  private onEmitCb: (() => void) | null = null;

  constructor(id = "default") {
    // The primary instance keeps the original channel so built-in views + existing
    // consumers are untouched; extra instances get a per-id channel.
    super("propresenter", id === "default" ? "propresenter:status" : `propresenter:status:${id}`, OFFLINE);
    this.id = id;
  }

  protected get configured(): boolean {
    return !!this.host && !!this.port;
  }

  /** ProPresenter waits 5s before the first retry, not the shared 3s. */
  protected override get reconnectBaseMs(): number {
    return ERROR_BASE_MS;
  }

  /** Notified after this instance's status changes — the manager uses it to
   *  rebuild + broadcast the combined `propresenter:instances` payload. */
  setEmitListener(cb: () => void): void {
    this.onEmitCb = cb;
  }

  /** Latest polled status — lets a freshly-loaded dashboard hydrate immediately
   *  (we only broadcast on change, so otherwise it'd wait for the next slide). */
  getStatus(): ProPresenterStatusDTO {
    return this.getLatest();
  }

  configure(host: string, port: number, pollMs?: number): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    // Clamp to a sane floor so a bad setting can't hammer ProPresenter. Only the
    // fallback poll reads this; the stream has no cadence to set.
    this.pollMs = pollMs && pollMs >= 200 ? Math.floor(pollMs) : POLL_INTERVAL_MS;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    super.start();
  }

  /**
   * End this run before tearing anything down, so every continuation parked on
   * an await abandons its work when it resumes. See `epoch`.
   */
  override stop(): void {
    this.epoch++;
    super.stop();
  }

  /** Has the run that captured `epoch` been stopped or superseded? Checked after
   *  every await, because `running` alone cannot see a restart. */
  private stale(epoch: number): boolean {
    return !this.running || epoch !== this.epoch;
  }

  /**
   * Record the delay the base class chose, then arm it.
   *
   * The "reconnecting in Ns" log line has to say the real number, and the only
   * place that number exists is inside scheduleReconnect(). Reading it here beats
   * a second copy of `base * 2 ** attempt`, capped by serviceWindow, that would
   * start telling the operator a different figure the first time either changes.
   */
  protected override scheduleIn(delayMs: number): void {
    this.nextDelayMs = delayMs;
    super.scheduleIn(delayMs);
  }

  protected override teardown(): void {
    this.activeUuid = null;
    this.slideIdxZero = null;
    // Drop the playlist-items cache too, so a reconnect to a different (or edited)
    // service can't leak a stale "next item" from the previous playlist.
    this.playlistUuid = null;
    this.playlistItems = [];
    this.playlistRetryAt = 0;
    this.playlistFailures = 0;
    this.closeStream();
    this.frames = { active: null, slide: null, slideIndex: null, playlistActive: null, timers: null };
    // Re-probe the subscription on the next start(). An operator who upgrades
    // ProPresenter and reconfigures the integration gets the stream back without
    // restarting Stage; short of that the fallback is for the life of the run,
    // which the log line says out loud.
    this.streamFallback = false;
  }

  /** Hang up on the held stream and disarm everything it armed. */
  private closeStream(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    this.clearIdleWatchdog();
    this.unreadable.clear();
    const { stream, req } = this;
    this.stream = null;
    this.req = null;
    // Listeners first: destroying a held response emits 'error'/'aborted', and a
    // handler still attached would schedule a reconnect for a stream we closed
    // on purpose — which is a second timer racing the one stop() just cleared.
    //
    // BY NAME. A bare removeAllListeners() strips Node's own internal listeners
    // on the response too, and gets away with it only because the destroy below
    // follows immediately; these three are the ones subscribe() attaches.
    for (const event of ["data", "end", "error"] as const) stream?.removeAllListeners(event);
    stream?.destroy();
    req?.destroy();
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
      return { ok: false, message: errorMessage(err) };
    }
  }

  /** Whether this instance has somewhere to dial. `configured` on the base is
   *  protected, and the manager has to know which instances are worth asking:
   *  one that was never set up is not part of the macro union, and reporting it
   *  as unreachable would put a warning in the log of every site that does not
   *  use ProPresenter, every time somebody opens the rule editor. */
  get hasTarget(): boolean {
    return this.configured;
  }

  /**
   * This instance's macro names, in ProPresenter's own order.
   *
   * Cached briefly (see MACRO_CACHE_MS): the rule editor asks every configured
   * instance every time it opens, and that is a LAN round trip per booth machine
   * for a list that changes when somebody edits ProPresenter.
   *
   * A failure comes back on `error` rather than as a throw — the caller has to
   * be able to answer the editor with a list either way.
   */
  async listMacros(): Promise<MacroListResult> {
    const { host, port } = this;
    if (!host || !port) return { names: [], error: "ProPresenter is not configured" };
    const now = Date.now();
    if (this.macroCache && now - this.macroCache.at < MACRO_CACHE_MS) {
      return { names: this.macroCache.names, error: null };
    }
    try {
      const body = await getJson(host, port, "/v1/macros");
      const names = Array.isArray(body)
        ? body.map((m) => asString(pick(m, "id", "name"))).filter((n): n is string => !!n)
        : [];
      this.macroCache = { at: Date.now(), names };
      return { names, error: null };
    } catch (err) {
      // Not cached: a failed read must not pin an empty list for the next
      // MACRO_CACHE_MS, or the editor opened during a reboot stays empty long
      // after the machine came back.
      return { names: [], error: fetchFailureMessage(err, `${host}:${port}`) };
    }
  }

  /**
   * Run one macro BY NAME, for the `propresenter.macro` action.
   *
   * NEVER THROWS: not configured, unreachable and "no such macro" all come back
   * as `{ ok: false }`, exactly as reaperService.transport does, so one booth
   * machine that is off cannot stop the engine.
   *
   * `label` is the instance's display name — the operator picked "MA", not
   * `inst-2`, and the log line has to say the word they would recognise.
   *
   * The trigger is `GET /v1/macro/<id>/trigger`. A GET that changes state is
   * ProPresenter's own design, not a mistake here. `<id>` takes a uuid, a name
   * or an index; the NAME is what is stored, because names are portable across
   * the two booth machines and survive a re-import where a uuid is per-machine —
   * the same reasoning as plan-items storing a title rather than an id.
   */
  async triggerMacro(macro: string, label: string): Promise<MacroResult> {
    const name = String(macro ?? "").trim();
    if (!name) return { ok: false, detail: "no macro chosen" };
    const { host, port } = this;
    if (!host || !port) return { ok: false, detail: `${label} is not configured` };
    try {
      // Names contain spaces (SONG INTRO), so the name is a single encoded path
      // segment — unencoded it would be three segments and a 404 at best.
      const status = await getStatusCode(host, port, `/v1/macro/${encodeURIComponent(name)}/trigger`);
      if (status === 404) {
        // The failure that will actually happen months from now is a renamed or
        // deleted macro. "HTTP 404" alone costs a Sunday morning; the reason
        // names the macro and the machine. The log line carries the macro in its
        // prefix already, so the reason there does not repeat it.
        console.warn(`[propresenter] macro "${name}" failed: no such macro on ${label} (404)`);
        return { ok: false, detail: `no macro called "${name}" on ${label}` };
      }
      if (status >= 400) {
        console.warn(`[propresenter] macro "${name}" failed: HTTP ${status} on ${label}`);
        return { ok: false, detail: `${label} answered HTTP ${status}` };
      }
      console.log(`[propresenter] macro "${name}" triggered on ${label}`);
      return { ok: true, detail: `triggered "${name}" on ${label}` };
    } catch (err) {
      // NOT errorMessage: a destroyed request says only "timeout", and the
      // operator needs to know which machine did not answer.
      const detail = fetchFailureMessage(err, `${host}:${port}`);
      console.warn(`[propresenter] macro "${name}" failed: ${detail}`);
      return { ok: false, detail };
    }
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    const host = this.host;
    const port = this.port;
    const epoch = this.epoch;
    try {
      // Connectivity probe — gates the card badge and is the same request the
      // Test button makes. Kept ahead of the subscription so an unreachable
      // machine reads as unreachable rather than as an unsupported endpoint.
      await getJson(host, port, "/version");
      // stop() — or a restart, which puts `running` back to true inside the same
      // tick — can land inside that await. Without this the subscription below
      // opens a second stream nothing will ever close. See `epoch`.
      if (this.stale(epoch)) return;

      if (this.streamFallback) {
        await this.pollOnce(host, port, epoch);
        return;
      }

      const outcome = await this.subscribe(host, port);
      // Same gap on the way out: a run that ended while the subscribe was in
      // flight must not pin the NEXT run into the fallback, nor report an
      // outage for a socket its own stop() destroyed.
      if (this.stale(epoch)) return;
      if (outcome.kind === "unsupported") {
        console.warn(
          `[propresenter] status/updates unsupported (HTTP ${outcome.status}) — falling back to polling`,
        );
        this.streamFallback = true;
        await this.pollOnce(host, port, epoch);
        return;
      }
      // "failed" is a transport failure on the subscribe itself — the machine
      // answered /version and then went away, which is an outage and not an
      // unsupported endpoint. Into the shared catch, so it backs off like one.
      if (outcome.kind === "failed") throw outcome.error;
      // "streaming": nothing more to schedule. The stream drives from here, and
      // holding it open is the whole point — see the note above subscribe().
    } catch (err) {
      // stop() destroys the in-flight request, which surfaces here as a failure.
      // A deliberate shutdown is not an outage and must not write one to the log,
      // and a superseded run must not schedule a reconnect racing the live one.
      if (this.stale(epoch)) return;
      const msg = errorMessage(err);
      // Log only the first failure of an outage, then stay quiet until it recovers —
      // a machine off all week shouldn't spam the log every retry.
      if (this.attempt === 0) console.warn(`[propresenter] ${host}:${port} unreachable (${msg}) — backing off, will keep retrying quietly`);
      this.goOffline();
      this.report("error", `Can't reach ${host}:${port} — ${msg}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Open the one held stream, and say what came back.
   *
   * NO DEMAND GATE, deliberately, and this reverses what the poll did. Five
   * requests a second at nobody was worth dropping to a five-second keepalive;
   * an idle subscription costs one ~40-byte heartbeat frame a second and no
   * requests at all, so it is cheaper than the keepalive poll that gate fell
   * back to. Closing it when the last browser leaves would buy nothing and cost
   * the first display that opens a blank panel until the subscribe completes —
   * and it would put the in-process consumers `inDemand` exists to count back
   * in the same hole.
   *
   * Never throws: the three outcomes are all things the caller must tell apart.
   */
  private subscribe(host: string, port: number): Promise<SubscribeOutcome> {
    return new Promise((resolve) => {
      const body = JSON.stringify(STREAM_ENDPOINTS);
      let settled = false;
      const settle = (outcome: SubscribeOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      // Declared ahead of the request so the response handler can clear it. As a
      // `const` after the http.request() call it sits in a temporal dead zone
      // that only Node's promise never to call the handler synchronously keeps
      // safe, and that is not a thing to depend on.
      let headerTimer: ReturnType<typeof setTimeout> | null = null;
      const clearHeaderTimer = (): void => {
        if (headerTimer) clearTimeout(headerTimer);
        headerTimer = null;
      };

      const req = http.request(
        {
          host,
          port,
          method: "POST",
          path: "/v1/status/updates?sse",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Accept: "text/event-stream",
          },
        },
        (res) => {
          clearHeaderTimer();
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            res.resume();
            res.destroy();
            // Forget the request: the caller is about to start polling, and a
            // late 'error' on this dead handle must not schedule a reconnect on
            // top of the poll timer. endStream's guard reads these two fields.
            this.req = null;
            settle({ kind: "unsupported", status });
            return;
          }
          // Deliberately NOT gated on a text/event-stream content-type: 21.3
          // answers this request with `transfer-encoding: chunked` and no
          // content-type at all, so requiring one would reject the live shape.
          this.stream = res;
          res.setEncoding("utf8");
          console.log(`[propresenter] streaming ${STREAM_ENDPOINTS.length} endpoints from ${host}:${port}`);
          this.report("connected", `Streaming from ${host}:${port}`);

          const reader = createSseReader({
            maxBuffer: STREAM_MAX_BUFFER,
            onOverflow: () =>
              console.warn(
                `[propresenter] status buffer exceeded ${STREAM_MAX_BUFFER} chars from ${host}:${port} — resyncing`,
              ),
          });
          res.on("data", (chunk: string) => {
            // Data, not a 2xx, is what proves the stream is real. Resetting the
            // back-off on the response header instead would let a peer that
            // accepts the subscribe and hangs up immediately spin at the base
            // delay for ever.
            this.resetBackoff();
            this.armIdleWatchdog();
            for (const event of reader.push(chunk)) this.handleStreamEvent(event.event, event.data);
          });
          res.on("end", () => this.endStream("closed by ProPresenter"));
          res.on("error", (err) => this.endStream(errorMessage(err)));
          this.armIdleWatchdog();
          settle({ kind: "streaming" });
        },
      );
      this.req = req;
      // A deadline on the RESPONSE HEADERS only, cleared the moment they arrive.
      //
      // Not `timeout:` on the request, which is a socket-inactivity timer and
      // would go on killing a perfectly healthy stream every time the stage is
      // quiet — the exact shape of the bug this file has already shipped once,
      // where a timeout sat on test() and not on the long-lived path. Without
      // something here, a peer that accepts the TCP connection and then never
      // answers leaves this promise pending for ever: connect() never returns,
      // nothing is scheduled, and the instance is wedged with no log line.
      headerTimer = setTimeout(() => {
        req.destroy(new Error(`no response to status/updates within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      // The primary liveness check — see SOCKET_KEEPALIVE_MS.
      keepSocketAlive(req, SOCKET_KEEPALIVE_MS);
      req.on("error", (err) => {
        clearHeaderTimer();
        // Fires both before the response (never connected) and after (the socket
        // died mid-stream). Only the first is an outcome; the second is an end.
        if (settled) this.endStream(errorMessage(err));
        else {
          // Same reason as the unsupported branch above, and the other half of
          // the same fix: the caller is about to back off and re-dial, and a
          // late event on this dead handle would reach endStream — whose only
          // guard is these two fields — and schedule a second reconnect racing
          // the first.
          this.req = null;
          settle({ kind: "failed", error: err });
        }
      });
      req.end(body);
    });
  }

  /** The stream is over. Log it once per outage, then back off and re-dial. */
  private endStream(reason: string): void {
    if (!this.stream && !this.req) return; // already torn down on purpose
    this.closeStream();
    if (!this.running) return;
    // `attempt` is 0 for the first end after data last flowed, so an isolated
    // drop is logged and a peer flapping open/closed says it once. The badge is
    // left alone on purpose: the next connect() probes /version, and a machine
    // that is genuinely gone fails THERE and reports the error with an address
    // in it. Flipping it here would flap the card green/red on every reconnect.
    const first = this.attempt === 0;
    this.scheduleReconnect();
    if (first) {
      console.warn(
        `[propresenter] stream ended (${reason}) — reconnecting in ${Math.round(this.nextDelayMs / 1000)}s`,
      );
    }
  }

  /** Restart the silence watchdog. See STREAM_IDLE_MS. */
  private armIdleWatchdog(): void {
    this.clearIdleWatchdog();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.endStream(`no heartbeat for ${Math.round(this.streamIdleMs / 1000)}s`);
    }, this.streamIdleMs);
  }

  private clearIdleWatchdog(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * File one frame under the endpoint it belongs to, and queue a publish.
   *
   * THE EVENT NAME IS NOT THE NAME THAT WAS SUBSCRIBED. Verified on 21.3 against
   * the exact six-endpoint subscription above:
   *
   *   subscribed                    arrives as
   *   status/slide                  event: /v1/status/slide
   *   timers/current                event: /v1/timers/current
   *   playlist/active               event: /v1/playlist/active
   *   timer/system_time             event: /v1/timer/system_time
   *   presentation/slide_index      event: v1/presentation/slide_index
   *   presentation/active           event: v1/presentation/current
   *
   * Three separate traps in one list. The name is version-prefixed, so matching
   * the subscribed name finds nothing at all. The leading slash is on four of the
   * six and absent from the two `presentation/*` ones, so demanding it loses
   * sections, slide count and progress. And `presentation/active` is delivered
   * under a different endpoint name entirely — `presentation/current` — which is
   * the 14KB document every one of those fields is derived from.
   *
   * Hence: strip an optional leading slash and an optional `vN/`, then match, and
   * accept both names for the document. Unknown endpoints are ignored rather than
   * logged — a point release adding a frame must not fill the log.
   */
  private handleStreamEvent(name: string | null, data: string): void {
    const endpoint = streamEndpointOf(name);
    if (!endpoint) return;
    // The heartbeat. It has already re-armed the watchdog in the data handler and
    // contributes nothing to the DTO, so it must not cost a rebuild of the whole
    // presentation once a second.
    if (endpoint === "timer/system_time") return;

    let parsed: unknown;
    try {
      parsed = data ? JSON.parse(data) : null;
    } catch (err) {
      // Degraded rather than rethrown, for the same reason the playlist read a
      // hundred lines below is: a frame this app cannot read is ONE field going
      // stale, and dropping a healthy stream over it would blank the slide, the
      // sections and the timers with it. The failure is returned to the operator
      // as that field simply ceasing to advance, and it is on the log with the
      // endpoint, the reason and the address — a truncated frame and a schema
      // change are the same blank panel and different fixes.
      //
      // Once per endpoint per stream, matching the playlist's discipline: a
      // schema change fires on every slide advance, and a line each would be the
      // whole log by the end of a service.
      if (!this.unreadable.has(endpoint)) {
        this.unreadable.add(endpoint);
        console.warn(
          `[propresenter] unreadable ${endpoint} frame from ${this.host}:${this.port} ` +
            `(${errorMessage(err)}) — that field stops advancing, staying quiet about the rest`,
        );
      }
      return;
    }

    switch (endpoint) {
      case "status/slide":
        this.frames.slide = parsed;
        break;
      case "presentation/slide_index":
        this.frames.slideIndex = parsed;
        break;
      case "presentation/active":
      case "presentation/current":
        this.frames.active = parsed;
        break;
      case "playlist/active":
        this.frames.playlistActive = parsed;
        break;
      case "timers/current":
        this.frames.timers = parsed;
        break;
      default:
        return; // not one of ours
    }
    this.queuePublish();
  }

  /** Collapse a burst of frames into one DTO. See PUBLISH_COALESCE_MS. */
  private queuePublish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.publishSerially();
    }, PUBLISH_COALESCE_MS);
  }

  /**
   * One publish at a time, and never a lost frame.
   *
   * The timer above nulls itself BEFORE publish() runs, so a frame arriving while
   * publish is inside the playlist fetch arms a fresh timer and a second publish
   * starts alongside the first. In the steady state the fetch resolves in a
   * microtask and nothing interleaves — but the moment the playlist changes or a
   * retry comes due there is a real request in flight, and two publishes both
   * read the playlist identifier that has not been reassigned yet: two identical
   * requests, both emitting, and if the first is slower the OLDER frame
   * broadcasts last. That is the mismatched frame PUBLISH_COALESCE_MS exists to
   * keep off every display, arriving by the other door.
   *
   * Re-queued rather than dropped: the frame that lost the race is the newest
   * one, and dropping it leaves the display a slide behind until something else
   * changes.
   */
  private async publishSerially(): Promise<void> {
    if (this.publishing) {
      this.publishAgain = true;
      return;
    }
    this.publishing = true;
    try {
      do {
        this.publishAgain = false;
        await this.publish();
      } while (this.publishAgain && this.running);
    } finally {
      this.publishing = false;
    }
  }

  private async publish(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    const epoch = this.epoch;
    const { active, slide, slideIndex, playlistActive, timers } = this.frames;
    const services = await this.resolveServiceItems(this.host, this.port, playlistActive, epoch);
    // stop() — or a restart — landed inside the playlist fetch.
    if (this.stale(epoch)) return;
    this.emit(this.buildStatus(active, slide, slideIndex, services, timers));
  }

  /**
   * One round of the old six-request poll — the fallback, and nothing else.
   *
   * Unchanged from what shipped, demand gate included: this path really does
   * five requests a cycle, so backing off when nothing is watching is still the
   * right trade for it.
   */
  private async pollOnce(host: string, port: number, epoch: number): Promise<void> {
    const [active, slide, slideIndex, playlistActive, timers] = await Promise.all([
      getJson(host, port, "/v1/presentation/active").catch(() => null),
      getJson(host, port, "/v1/status/slide").catch(() => null),
      getJson(host, port, "/v1/presentation/slide_index").catch(() => null),
      getJson(host, port, "/v1/playlist/active").catch(() => null),
      getJson(host, port, "/v1/timers/current").catch(() => null),
    ]);
    // Five round trips wide. A stopped instance emitting "connected" here undoes
    // the OFFLINE frame stop() just published; a superseded one emits the old
    // machine's slide onto the new one's channel.
    if (this.stale(epoch)) return;

    const services = await this.resolveServiceItems(host, port, playlistActive, epoch);
    if (this.stale(epoch)) return;

    this.emit(this.buildStatus(active, slide, slideIndex, services, timers));
    this.report("connected", `Connected to ${host}:${port}`);
    this.resetBackoff(); // reconnected
    // Fast poll only while something consumes this instance; else keepalive.
    // `inDemand` and not an SSE-subscriber check: nothing in-process reads this
    // payload today, so the two are identical — but the moment one does, a
    // browser-only check would quietly hand it five-second-old slides instead.
    this.scheduleIn(this.inDemand ? this.pollMs : IDLE_INTERVAL_MS);
  }

  /**
   * Current + next service (playlist) item names.
   *
   * Caches the items list and re-reads `/v1/playlist/{uuid}` only when the active
   * playlist changes — or when a recorded failure comes due for a retry.
   *
   * THE UUID IS RECORDED EITHER WAY. It used to be assigned only on the success
   * path, so a playlist that could not be read never satisfied the "has it
   * changed?" guard and was re-fetched on every single cycle, for ever. That is
   * not hypothetical: the API answers 404 for a Planning Center linked playlist,
   * which is a normal Sunday here, so the failing branch was the steady state and
   * it cost a request per poll on top of the six.
   */
  private async resolveServiceItems(
    host: string,
    port: number,
    playlistActive: unknown,
    epoch: number,
  ): Promise<{ current: string | null; next: string | null }> {
    const pUuid = asString(pick(playlistActive, "presentation", "playlist", "uuid"));
    const curName = asString(pick(playlistActive, "presentation", "item", "name"));
    const curIndex = asNumber(pick(playlistActive, "presentation", "item", "index"));
    if (!pUuid) return { current: curName, next: null };

    // A different playlist is read at once; the same one that failed waits out
    // its back-off. Checked in that order on purpose — an operator switching to
    // a readable playlist must not be made to wait for the broken one's timer.
    const changed = pUuid !== this.playlistUuid;
    const retryDue = this.playlistRetryAt > 0 && Date.now() >= this.playlistRetryAt;
    if (changed || retryDue) {
      if (changed) {
        this.playlistFailures = 0;
        this.playlistRetryAt = 0;
      }
      try {
        const pl = await getJson(host, port, `/v1/playlist/${pUuid}`);
        // teardown() empties this cache precisely so a reconnect to a different
        // (or edited) service cannot leak a stale "next item". A read that was
        // already in flight must not put the old one straight back.
        if (this.stale(epoch)) return { current: curName, next: null };
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
        this.playlistFailures = 0;
        this.playlistRetryAt = 0;
      } catch (err) {
        if (this.stale(epoch)) return { current: curName, next: null };
        // Not rethrown, and this is the one place in this file that degrades
        // rather than propagates: the caller is about to publish a whole status
        // frame, and failing it because one optional field could not be resolved
        // would blank the slide, the sections and the timers along with it. The
        // failure IS returned — `next` comes back null, which is what the display
        // shows — and it is on the log with the reason and the address.
        this.playlistUuid = pUuid; // recorded on failure too: see the note above
        this.playlistItems = [];
        this.playlistFailures++;
        const wait = Math.min(
          this.playlistRetryBaseMs * 2 ** (this.playlistFailures - 1),
          this.playlistRetryMaxMs,
        );
        this.playlistRetryAt = Date.now() + wait;
        if (this.playlistFailures === 1) {
          // Once per playlist, not once per frame. The retry is quiet after this.
          console.warn(
            `[propresenter] playlist unreadable on ${host}:${port} (${errorMessage(err)}) — ` +
              `no next-item name, retrying in ${Math.round(wait / 1000)}s`,
          );
        }
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
          ? clamp(idxZeroRaw, 0, total - 1)
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

  protected override emit(status: ProPresenterStatusDTO): void {
    this.last = status;
    // Only push when something actually changed — at 2 Hz an unchanged broadcast
    // would re-render every dashboard for nothing.
    const json = JSON.stringify(status);
    if (json === this.lastJson) return;
    this.lastJson = json;
    // Stamped, and bumped only here — past the unchanged-frame return above, so
    // the version advances exactly when a real change is published. The hydrate
    // read answers from getLatest(), which carries the same counter, letting a
    // dashboard drop a read that is older than a push it already applied.
    // `lastJson` is taken from the UNSTAMPED status so the change test is
    // unaffected by the counter.
    this.bumpRev();
    broadcast(this.channel, this.stamped(status));
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
  private conn = new Map<string, PropInstanceConn>(); // id → reachability (extras only)
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
        this.conn.delete(id);
      }
    }
    for (const e of extras) {
      let svc = this.extras.get(e.id);
      if (!svc) {
        svc = new ProPresenterService(e.id);
        svc.setEmitListener(() => this.broadcastCombined());
        // Surface reachability the same way the primary does (connecting → the
        // service's listener flips it to connected/error on the first tick).
        svc.setConnectionListener((state, message) => {
          this.conn.set(e.id, { state, message });
          this.broadcastCombined();
        });
        this.extras.set(e.id, svc);
      }
      this.names.set(e.id, e.name?.trim() || e.id);
      if (e.enabled !== false && e.host && e.port > 0) {
        this.conn.set(e.id, { state: "connecting", message: `Polling ${e.host}:${e.port}` });
        svc.configure(e.host, e.port, e.pollMs);
      } else {
        svc.stop();
        this.conn.set(e.id, { state: "disconnected", message: null });
      }
    }
    this.broadcastCombined();
  }

  private broadcastCombined(): void {
    broadcast("propresenter:instances", this.getInstancesDto());
  }

  getInstancesDto(): PropInstancesDTO {
    const list: PropInstanceMeta[] = this.listInstances();
    const status: Record<string, ProPresenterStatusDTO> = {
      default: propresenterService.getStatus(),
    };
    for (const [id, svc] of this.extras) status[id] = svc.getStatus();
    // The primary's rich state lives on its integration card; here we derive it
    // from the polled status so the map is complete. Extras carry their own state.
    const conn: Record<string, PropInstanceConn> = {
      default: {
        state: propresenterService.getStatus().connected ? "connected" : "disconnected",
        message: null,
      },
    };
    for (const id of this.extras.keys()) {
      conn[id] = this.conn.get(id) ?? { state: "disconnected", message: null };
    }
    return { list, status, conn };
  }

  /** Thumbnail target for a given instance ("default"/empty → primary). */
  getThumbnailTarget(id: string | null | undefined) {
    if (!id || id === "default") return propresenterService.getThumbnailTarget();
    return this.extras.get(id)?.getThumbnailTarget() ?? null;
  }

  /** Every instance a rule can address: the primary plus the configured extras. */
  listInstances(): { id: string; name: string }[] {
    return [
      { id: "default", name: this.defaultName },
      ...[...this.extras.keys()].map((id) => ({ id, name: this.names.get(id) ?? id })),
    ];
  }

  /** The service + display name behind an instance id, or null for one that is
   *  not there. Blank/"default" means the primary, the same as everywhere else
   *  a layout object names an instance. */
  private resolve(id: string | null | undefined): { svc: ProPresenterService; label: string } | null {
    if (!id || id === "default") return { svc: propresenterService, label: this.defaultName };
    const svc = this.extras.get(id);
    return svc ? { svc, label: this.names.get(id) ?? id } : null;
  }

  /**
   * Macro names on one instance. An unknown instance id is a RETURNED failure,
   * not a throw: an operator can delete an instance a rule still names, and that
   * has to read as a failed action rather than a crashed engine.
   */
  async listMacros(instanceId: string | null | undefined): Promise<MacroListResult> {
    const target = this.resolve(instanceId);
    if (!target) return { names: [], error: `no ProPresenter instance "${instanceId}"` };
    return target.svc.listMacros();
  }

  /**
   * Every macro name across every CONFIGURED instance, unioned, with where each
   * one lives.
   *
   * Instances are read in parallel and independently: one machine being off
   * costs its own macros, never the other's. An instance that could not be read
   * is named on `unreachable` so the caller can say so — silently dropping it
   * would make its macros look deleted.
   *
   * An instance with no host is not asked and is not counted. It is not a
   * failure — it is an instance that does not exist yet — and counting it would
   * both log a warning on every editor open at a site that does not use
   * ProPresenter, and mark every real macro as living on one machine "only"
   * because the phantom one did not report it.
   */
  async allMacros(): Promise<{
    names: { name: string; instances: string[] }[];
    instanceCount: number;
    unreachable: string[];
  }> {
    const instances = this.listInstances().filter((i) => this.resolve(i.id)?.svc.hasTarget);
    const results = await Promise.all(instances.map((i) => this.listMacros(i.id)));
    // A Map keyed by name preserves first-seen order, which is ProPresenter's
    // own macro order on the primary — the order the operator sees in the app.
    const byName = new Map<string, string[]>();
    const unreachable: string[] = [];
    results.forEach((r, idx) => {
      const label = instances[idx].name;
      if (r.error) {
        unreachable.push(label);
        return;
      }
      for (const name of r.names) {
        const seen = byName.get(name);
        if (seen) {
          if (!seen.includes(label)) seen.push(label);
        } else {
          byName.set(name, [label]);
        }
      }
    });
    if (unreachable.length) {
      console.warn(`[propresenter] macro list unavailable from ${unreachable.join(", ")} — offering the rest`);
    }
    return {
      names: [...byName].map(([name, on]) => ({ name, instances: on })),
      instanceCount: instances.length,
      unreachable,
    };
  }

  /** Trigger a macro by name on one instance, for the `propresenter.macro`
   *  action. Never throws — see ProPresenterService.triggerMacro. */
  async triggerMacro(instanceId: string | null | undefined, macro: string): Promise<MacroResult> {
    const target = this.resolve(instanceId);
    if (!target) {
      const detail = `no ProPresenter instance "${instanceId}" — re-pick it on this rule`;
      console.warn(`[propresenter] macro "${String(macro ?? "").trim()}" failed: ${detail}`);
      return { ok: false, detail };
    }
    return target.svc.triggerMacro(macro, target.label);
  }
}

export const propresenterManager = new ProPresenterManager();
