// Shared SSE relay — one EventSource for ALL same-origin tabs/windows on this
// machine, fanning events out to each tab's MessagePort. Collapses N tabs' N
// connections to 1, sidestepping the browser's ~6-per-origin HTTP/1.1 connection
// limit that stalls the control machine when many displays/settings tabs are open.
//
// Opt-in (see api.ts): the direct per-tab EventSource path stays the default. This
// runs only when localStorage["stage:sharedSse"] === "1".
//
// Each tab reports the channels it renders; the worker unions them, reports that set
// to the server (so filtering still applies), attaches an EventSource listener per
// channel, and forwards each event only to the ports that asked for that channel.

// The renderer tsconfig uses the DOM lib (self: Window), so type the shared-worker
// global locally instead of redeclaring `self` (which would conflict).
const ctx = self as unknown as { onconnect: ((e: MessageEvent) => void) | null };

const portChannels = new Map<MessagePort, Set<string>>();
const attached = new Set<string>();
let es: EventSource | null = null;
// One stable id for the shared connection (insecure-context safe — no crypto.randomUUID).
const cid = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
      fanout(channel, JSON.parse((e as MessageEvent).data));
    } catch {
      /* malformed frame — ignore */
    }
  });
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

function ensureEs(): void {
  if (es && es.readyState !== EventSource.CLOSED) return;
  es = new EventSource(`/api/events?cid=${encodeURIComponent(cid)}`);
  attached.clear();
  es.onopen = () => report(); // re-report + re-attach after every (re)connect
  for (const c of union()) attach(c);
}

ctx.onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  portChannels.set(port, new Set());
  port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { type?: string; channels?: string[] };
    if (m.type === "subscribe") {
      portChannels.set(port, new Set(m.channels ?? []));
      report();
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
