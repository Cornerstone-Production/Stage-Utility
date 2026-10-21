// public-live.ts — how the public ServiceCue page hears the church.
//
// The page has one Cloudflare Worker to talk to, and its live frames arrive on one
// WebSocket, `/api/live`, on the page's own origin. This is that transport, used ONLY on
// the public page (see public-mode.ts); the building's three are untouched. It
//
//  1. keeps a socket open, and reopens it with a backoff when it closes;
//  2. hands each frame to the page's subscribers through the same per-channel dispatch
//     the other transports end in, and says `publish:docs` for every doc after each
//     (re)connect, because a doc changed while it was away is not replayed;
//  3. sets the page's clock from the edge, once per connection, over a request whose
//     round trip is measured;
//  4. records when the church was last heard from (PublicFreshness), from the socket,
//     and over HTTP while the socket is not open;
//  5. offers the build a heartbeat names to public-build.ts.
//
// It writes nothing to the Worker but the word "ping".

import { errorMessage } from "@main/services/errors";
import {
  DOCS_CHANNEL,
  HEARTBEAT_CHANNEL,
  HEARTBEAT_PATH,
  LIVE_CHANNELS,
  LIVE_PATH,
  type DocsFrameData,
  type HeartbeatAnswer,
  type HeartbeatFrameData,
} from "@main/types/servicecue-publish";
import { reloadForNewBuild } from "./public-build";
import { monotonicNow } from "./server-clock";

/** What the transport needs from the page it runs in. */
export interface PublicLiveDeps {
  /** One frame, to every subscriber of its channel: api.ts's dispatch. */
  deliver: (channel: string, data: unknown) => void;
  /** A reading of the edge's clock and the round trip it was measured over. */
  observeClock: (edgeMs: number, rttMs: number) => void;
}

/** The first retry waits this long, and each failure doubles it up to the cap. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** How often an open socket is asked whether anyone is there. */
export const PING_EVERY_MS = 30_000;
/**
 * How long an open socket may say nothing, a pong included, before it is taken to be
 * dead and replaced. A quiet church does not trigger this, because the pong answers the
 * page's own ping; a connection that no longer carries anything does.
 */
export const DEAD_AFTER_MS = 75_000;
/** How often the Worker is asked over HTTP while there is no socket, and how long a new page waits for one first. */
export const READ_EVERY_MS = 60_000;
export const FIRST_READ_AFTER_MS = 3_000;

const OPEN = 1;

// ── When the church was last heard from ───────────────────────────────────────

/**
 * What the "Not updating" notice reads. Every time here is on THIS page's own monotonic
 * clock, so nothing the church's clock or the visitor's says can move it: a frame is
 * heard when it arrives, and a reading the edge stamped (a heartbeat's `at` against the
 * `now` it came with) is aged by the edge's own two numbers.
 */
export interface PublicFreshness {
  /** When the church was last heard from, or null if it has not been. */
  heardAtMono: number | null;
  /** When the page began watching: with nothing heard, the silence is counted from here. */
  watchingSinceMono: number;
  /** Edge time minus this clock's, from the last reading the edge stamped; null before one. */
  edgeOffsetMs: number | null;
}

let freshness: PublicFreshness = { heardAtMono: null, watchingSinceMono: monotonicNow(), edgeOffsetMs: null };
const freshnessListeners = new Set<() => void>();

export function getPublicFreshness(): PublicFreshness {
  return freshness;
}

export function subscribePublicFreshness(listener: () => void): () => void {
  freshnessListeners.add(listener);
  return () => freshnessListeners.delete(listener);
}

function setFreshness(next: PublicFreshness): void {
  if (next.heardAtMono === freshness.heardAtMono && next.edgeOffsetMs === freshness.edgeOffsetMs) return;
  freshness = next;
  for (const listener of [...freshnessListeners]) listener();
}

/** The church was heard from at this moment (never an older moment than one already heard). */
function hear(atMono: number): void {
  setFreshness({ ...freshness, heardAtMono: Math.max(atMono, freshness.heardAtMono ?? atMono) });
}

/** The edge's clock read `edgeMs` at this moment of ours. */
function anchor(edgeMs: number, atMono: number): void {
  setFreshness({ ...freshness, edgeOffsetMs: edgeMs - atMono });
}

/**
 * A moment of this page's clock on the edge's, for the time the notice prints. Falls
 * back on the visitor's own clock where the edge has never stamped a reading, which can
 * only make that one printed time wrong, never the notice itself.
 */
export function edgeTimeOf(atMono: number): number {
  return atMono + (freshness.edgeOffsetMs ?? Date.now() - monotonicNow());
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// ── The socket ────────────────────────────────────────────────────────────────

let deps: PublicLiveDeps | null = null;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let readTimer: ReturnType<typeof setInterval> | null = null;
let firstReadTimer: ReturnType<typeof setTimeout> | null = null;
/** The monotonic time anything last arrived on the open socket. */
let lastMessageAt = 0;
/** Connections that failed since one last worked, so a streak is said once. */
let failures = 0;
let watchingVisibility = false;

/** Is the live socket open right now? The pages that poll the building's server ask, so they do not poll this one's. */
export function isPublicSocketOpen(): boolean {
  return socket?.readyState === OPEN;
}

/** Start the transport. Idempotent: every subscription asks, the first one starts it. */
export function startPublicLive(d: PublicLiveDeps): void {
  if (deps) return;
  deps = d;
  if (!watchingVisibility && typeof document !== "undefined") {
    watchingVisibility = true;
    document.addEventListener("visibilitychange", onVisible);
  }
  // Without a socket the page still asks: once a few seconds after loading if none has
  // opened by then, and every minute after for as long as there is none.
  const readIfNoSocket = () => {
    if (!isPublicSocketOpen()) void readEdge();
  };
  firstReadTimer = setTimeout(readIfNoSocket, FIRST_READ_AFTER_MS);
  readTimer = setInterval(readIfNoSocket, READ_EVERY_MS);
  connect();
}

function socketUrl(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${LIVE_PATH}`;
}

function connect(): void {
  if (socket) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(socketUrl());
  } catch (err) {
    // The constructor throws for an address it will not open (a blocked scheme, a
    // policy). That is not a state to give up in: the page says so once and tries
    // again on the backoff, as it does for a connection that closed.
    failures++;
    if (failures === 1) console.warn("[public-live] could not open the live connection; will retry", err);
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    if (failures > 0) console.log(`[public-live] live connection restored after ${failures} failed attempt(s)`);
    failures = 0;
    reconnectDelayMs = RECONNECT_MIN_MS;
    lastMessageAt = monotonicNow();
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(checkAlive, PING_EVERY_MS);
    void readEdge();
    // Whatever the Worker said before this socket opened, this page did not hear.
    const everything: DocsFrameData = { keys: [], all: true };
    deps?.deliver(DOCS_CHANNEL, everything);
  };
  ws.onmessage = (event) => {
    if (socket === ws) onMessage(event.data);
  };
  // An error is always followed by a close, and the close is what is acted on.
  ws.onclose = () => {
    if (socket === ws) lose(ws, "it closed");
  };
}

/** The socket is gone, or is taken to be. Forget it and come back. */
function lose(ws: WebSocket, why: string): void {
  ws.onopen = ws.onmessage = ws.onclose = null;
  if (ws.readyState === OPEN || ws.readyState === 0) ws.close();
  socket = null;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  failures++;
  // Once per streak: a phone asleep in a pocket would otherwise write a line per retry.
  if (failures === 1) console.warn(`[public-live] the live connection was lost (${why}); reconnecting`);
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  // Spread out, so that every viewer a Worker deploy dropped does not come back in the same second.
  const delay = Math.round(reconnectDelayMs * (0.75 + Math.random() * 0.5));
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** Ask an open socket whether anyone is there, and replace one that has said nothing for too long. */
function checkAlive(): void {
  const ws = socket;
  if (!ws || ws.readyState !== OPEN) return;
  if (monotonicNow() - lastMessageAt > DEAD_AFTER_MS) {
    lose(ws, "nothing arrived, not even an answer to a ping");
    return;
  }
  try {
    ws.send("ping");
  } catch (err) {
    lose(ws, `a ping could not be sent: ${errorMessage(err)}`);
  }
}

/** A tab brought back to the front: a phone's socket is often dead by then, and says nothing about it. */
function onVisible(): void {
  if (typeof document === "undefined" || document.visibilityState !== "visible" || !deps) return;
  if (socket) {
    checkAlive();
    return;
  }
  // Waiting out a backoff the page grew while it was hidden helps nobody.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelayMs = RECONNECT_MIN_MS;
  connect();
}

// ── Frames ────────────────────────────────────────────────────────────────────

interface Frame {
  channel: string;
  data: unknown;
  replay: boolean;
}

function parseFrame(raw: unknown): Frame | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[public-live] ignored a message that is not JSON");
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { channel, data, replay } = parsed as { channel?: unknown; data?: unknown; replay?: unknown };
  // A channel this page does not know is a newer Worker's, not an error.
  if (typeof channel !== "string" || !(LIVE_CHANNELS as readonly string[]).includes(channel)) return null;
  return { channel, data, replay: replay === true };
}

function onMessage(raw: unknown): void {
  const received = monotonicNow();
  lastMessageAt = received;
  if (raw === "pong" || !deps) return;
  const frame = parseFrame(raw);
  if (frame === null) return;

  if (frame.channel === HEARTBEAT_CHANNEL) {
    const beat = frame.data as HeartbeatFrameData | null;
    if (!frame.replay) {
      // A live heartbeat is `at` itself, as it arrives.
      if (finite(beat?.at)) anchor(beat.at, received);
      hear(received);
    } else if (finite(beat?.now)) {
      // The replay is the last heartbeat, aged by the edge's own clock: `now` is when the
      // Worker sent it, `at` when that heartbeat arrived. A replay with no `now` says
      // nothing about how old it is, and is not taken for news.
      anchor(beat.now, received);
      if (finite(beat?.at)) hear(received - Math.max(0, beat.now - beat.at));
    }
    // On the replay at connect, which is how a page dropped by a deploy hears of it, and
    // on every live heartbeat, for one whose socket survived.
    if (typeof beat?.build === "string") reloadForNewBuild(beat.build);
  } else if (!frame.replay) {
    // Anything the Worker sends live is the church's doing; a replay is only what it kept.
    hear(received);
  }
  deps.deliver(frame.channel, frame.data);
}

// ── The edge ──────────────────────────────────────────────────────────────────

/**
 * Read the edge's clock and when the church last sent a heartbeat, over a request whose
 * round trip is measured: for the page's clock (pushed frames carry no pairing, and the
 * clock refuses to be set by one), and as the page's only word on the church while it
 * has no socket.
 *
 * The catch hides nothing from a caller: this is the top of a task nothing awaits, and
 * a failed read leaves the page as it was. A page that cannot hear the church by either
 * road says so by its notice, two minutes on.
 */
async function readEdge(): Promise<void> {
  const sentAt = monotonicNow();
  try {
    const res = await fetch(HEARTBEAT_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Text first, parsed after the arrival is stamped, so the parse is not counted in the round trip.
    const text = await res.text();
    const arrived = monotonicNow();
    const rttMs = arrived - sentAt;
    const body = JSON.parse(text) as Partial<HeartbeatAnswer>;
    if (!finite(body.now)) return;
    deps?.observeClock(body.now, rttMs);
    const when = arrived - rttMs / 2; // the edge read its clock about halfway
    anchor(body.now, when);
    if (finite(body.at)) hear(when - Math.max(0, body.now - body.at));
  } catch (err) {
    console.warn("[public-live] could not read the edge's clock and heartbeat; the page keeps what it has", err);
  }
}

/** Test seam: close the socket, stop every timer and forget everything, so a case starts from a page that has just loaded. */
export function __resetPublicLiveForTests(): void {
  for (const t of [reconnectTimer, firstReadTimer]) if (t) clearTimeout(t);
  for (const t of [pingTimer, readTimer]) if (t) clearInterval(t);
  reconnectTimer = pingTimer = readTimer = firstReadTimer = null;
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = null;
    ws.close();
  }
  if (watchingVisibility && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  watchingVisibility = false;
  deps = null;
  reconnectDelayMs = RECONNECT_MIN_MS;
  lastMessageAt = 0;
  failures = 0;
  freshness = { heardAtMono: null, watchingSinceMono: monotonicNow(), edgeOffsetMs: null };
  freshnessListeners.clear();
}
