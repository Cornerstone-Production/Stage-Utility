// Shared SSE relay — one EventSource for ALL same-origin tabs/windows on this
// machine, fanning events out to each tab's MessagePort. Collapses N tabs' N
// connections to 1, sidestepping the browser's ~6-per-origin HTTP/1.1 connection
// limit that stalls the control machine when many displays/settings tabs are open.
//
// Measured: three tabs hold three connections on the direct path and one through
// here. On the direct path the sixth tab cannot load at all — every socket is a
// long-lived stream, so its /api/state has nothing left to go out on and dies at
// the client timeout.
//
// Each tab reports the channels it renders; the worker unions them, reports that
// set to the server (so filtering still applies), attaches an EventSource listener
// per channel, and forwards each event only to the ports that asked for it.
//
// ── Why this file carries its own resilience ────────────────────────────────
// Sharing one stream makes a dropped stream WORSE, not better: on the direct path
// a dead stream costs one tab, here it would take every tab on the machine dark
// at once. So the three mechanisms api.ts has around its own EventSource are not
// optional here — they are the price of sharing, and this file went out opt-in
// until it had them.

import { HYDRATED_SET } from "./sse-channels";

// The renderer tsconfig uses the DOM lib (self: Window), so type the shared-worker
// global locally instead of redeclaring `self` (which would conflict).
const ctx = self as unknown as { onconnect: ((e: MessageEvent) => void) | null };

const portChannels = new Map<MessagePort, Set<string>>();
const attached = new Set<string>();
/**
 * Last payload seen per hydrated channel.
 *
 * The server re-sends state on connect, but this worker connects ONCE for the
 * machine — so a tab opened afterwards is not present for any burst and would
 * render nothing on those channels until the value happened to change. On a quiet
 * channel that is minutes: a countdown simply blank on a display someone just
 * opened. api.ts solves the same problem for late-mounting components; the shared
 * path has to solve it for late-arriving TABS.
 */
const lastPayload = new Map<string, unknown>();
let es: EventSource | null = null;
// One stable id for the shared connection (insecure-context safe — no crypto.randomUUID).
const cid = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
let reconnectDelayMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function union(): string[] {
  const u = new Set<string>();
  for (const set of portChannels.values()) for (const c of set) u.add(c);
  return [...u];
}

function fanout(channel: string, data: unknown): void {
  for (const [port, chans] of portChannels) {
    if (chans.has(channel)) port.postMessage({ channel, data });
  }
}

function attach(channel: string): void {
  if (attached.has(channel) || !es) return;
  attached.add(channel);
  es.addEventListener(channel, (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data);
      if (HYDRATED_SET.has(channel)) lastPayload.set(channel, data);
      fanout(channel, data);
    } catch {
      /* malformed frame — ignore */
    }
  });
}

/** Replay cached state to one port, for the channels it just asked for. */
function replayTo(port: MessagePort, channels: Iterable<string>): void {
  for (const c of channels) {
    if (!HYDRATED_SET.has(c)) continue;
    if (!lastPayload.has(c)) continue;
    port.postMessage({ channel: c, data: lastPayload.get(c) });
  }
}

function report(): void {
  ensureEs();
  const channels = union();
  for (const c of channels) attach(c);
  fetch("/api/events/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cid, channels }),
  }).catch(() => {
    /* filtering is an optimization — a failed report just means send-all */
  });
}

/**
 * Reopen a stream the browser has given up on, backing off so a server that is
 * still down is not hammered.
 *
 * EventSource retries on its own while it is CONNECTING; CLOSED means it has
 * stopped for good and nothing else would ever reopen it. That is what a display
 * looks like when it "stops updating" after a server restart — and here it would
 * be every display on the machine at once.
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
    ensureEs();
    report();
  }, reconnectDelayMs);
}

function ensureEs(): void {
  if (es && es.readyState !== EventSource.CLOSED) return;
  es = new EventSource(`/api/events?cid=${encodeURIComponent(cid)}`);
  attached.clear();
  es.onopen = () => {
    // A successful connect earns the short delay back, so one blip does not leave
    // the machine on a 30s cadence for the rest of the service.
    reconnectDelayMs = RECONNECT_MIN_MS;
    report(); // re-report + re-attach after every (re)connect
  };
  es.onerror = () => {
    if (es?.readyState === EventSource.CLOSED) scheduleReconnect();
  };
  for (const c of union()) attach(c);
}

ctx.onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  portChannels.set(port, new Set());
  port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { type?: string; channels?: string[] };
    if (m.type === "subscribe") {
      const wanted = new Set(m.channels ?? []);
      const previous = portChannels.get(port) ?? new Set<string>();
      portChannels.set(port, wanted);
      report();
      // Only what this port did not already have, so a re-subscribe (which happens
      // on every mount and unmount) does not re-deliver state it is already showing.
      replayTo(port, [...wanted].filter((c) => !previous.has(c)));
    } else if (m.type === "wake") {
      // A tab became visible. A kiosk can sit untouched for days, and the machine
      // may have slept with the stream closed underneath it; do not make it wait
      // out the backoff.
      if (!es || es.readyState === EventSource.CLOSED) {
        reconnectDelayMs = RECONNECT_MIN_MS;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        ensureEs();
        report();
      }
    } else if (m.type === "bye") {
      // Best-effort cleanup when a tab unloads (ports have no reliable close event).
      portChannels.delete(port);
      report();
    }
  };
  port.start();
  ensureEs();
  report();
};
