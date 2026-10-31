// display-presence.ts — Tracks which display outputs are currently connected.
//
// Each kiosk page (served at /display-{id}) POSTs a heartbeat to
// /api/displays/presence on load and on a timer (fast near/during a PCO service,
// slow otherwise), plus a sendBeacon "leaving" on unload. An output counts as
// connected while its last heartbeat is within TTL_MS — so an ungraceful death
// (power loss, network drop, crash) lapses to offline after the TTL even without a
// leaving beacon. Presence is ephemeral: purely in-memory, never persisted.
//
// The connected set is broadcast on "displays:presence" only when it changes, so
// the Screens page can light a per-display Connected/Offline dot.

import { broadcast } from "./broadcaster.js";

// Longest tolerated gap before an output is considered gone. Must exceed the
// slow client heartbeat (60s) plus jitter/grace, or a quiet display would flap.
const TTL_MS = 90_000;
const SWEEP_MS = 30_000;

const lastSeen = new Map<string, number>();
// When an output last reported before it sent a "leaving" beacon. `lastSeen`
// forgets an output the moment it leaves, which is right for "who is connected"
// and wrong for "when did Lobby TV drop" -- Home's Needs attention reads the
// answer to that. Bounded, because heartbeats carry any id a LAN client cares to
// send: past DEPARTED_MAX the oldest is dropped.
const departed = new Map<string, number>();
const DEPARTED_MAX = 256;
// Heartbeats carry any id a LAN client cares to send. An id longer than this is
// not an output id (they are short slugs) and is ignored.
const MAX_ID_LENGTH = 128;
// An output not heard from in this long is forgotten rather than kept for ever.
const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

// The ids of outputs that exist, so what is PUBLISHED (and serialised into every
// broadcast and hello burst) is bounded by the real screens, not by whatever
// ids have been posted. Null until the server registers one, which publishes
// everything (tests).
let knownOutputs: (() => ReadonlySet<string>) | null = null;
export function setKnownOutputIds(fn: (() => ReadonlySet<string>) | null): void {
  knownOutputs = fn;
}
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lastSig = "";

// Which broadcast a payload belongs to, so a client can order two deliveries of
// the same truth. A consumer hydrates with a GET and subscribes to the channel;
// without this it cannot tell whether a set that arrived while its read was in
// flight is newer than the read or older, and guessing wrong leaves it wrong
// until the next change -- which, on a channel that only broadcasts on change,
// can be hours. Bumped only when the set actually changes, so it also tells a
// client that nothing has happened.
let rev = 0;

function connectedNow(): string[] {
  const cutoff = Date.now() - TTL_MS;
  const out: string[] = [];
  for (const [id, t] of lastSeen) if (t >= cutoff) out.push(id);
  return out.sort();
}

/** Current connected-output snapshot — pushed to a client when its SSE opens,
 *  and served by GET /api/displays/presence. `rev` is the last broadcast this
 *  set is at least as new as; see the declaration above. */
export function presenceSnapshot(): PresenceSnapshot {
  return { connected: connectedNow(), rev, lastSeen: lastSeenPairs() };
}

/** What `displays:presence` carries and GET /api/displays/presence answers. */
export interface PresenceSnapshot {
  connected: string[];
  rev: number;
  /**
   * `[outputId, epochMs]` pairs: the last time each output reported in. An array
   * of pairs rather than a record, because the ids come off the wire. An output
   * that has never reported has no entry. Exact for an output that is not
   * connected -- which is what it is for -- and as of the last broadcast for one
   * that is, since a heartbeat on its own broadcasts nothing.
   */
  lastSeen: [string, number][];
}

function lastSeenPairs(): [string, number][] {
  const all = new Map(departed);
  for (const [id, t] of lastSeen) all.set(id, t);
  const known = knownOutputs?.();
  return [...all]
    .filter(([id]) => !known || known.has(id)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// Broadcast only when the connected set actually changes (change-driven, per the
// house SSE efficiency rule) — heartbeats themselves are silent.
function maybeBroadcast(): void {
  const conn = connectedNow();
  const sig = conn.join(",");
  if (sig === lastSig) return;
  lastSig = sig;
  rev += 1;
  broadcast("displays:presence", { connected: conn, rev, lastSeen: lastSeenPairs() } satisfies PresenceSnapshot);
}

/** One pass of the sweep: forget what has been silent for 30 days, then
 *  broadcast if the connected set moved. Exported for the test. */
export function sweepPresence(): void {
  const cutoff = Date.now() - FORGET_AFTER_MS;
  for (const m of [lastSeen, departed]) for (const [id, t] of m) if (t < cutoff) m.delete(id);
  maybeBroadcast();
  if (lastSeen.size === 0) {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepPresence, SWEEP_MS);
  // Don't hold the event loop open for the sweep alone.
  sweepTimer.unref?.();
}

/** Record a heartbeat from a display output. */
export function displayHeartbeat(outputId: string): void {
  if (outputId.length > MAX_ID_LENGTH) return;
  lastSeen.set(outputId, Date.now());
  departed.delete(outputId);
  ensureSweep();
  maybeBroadcast();
}

/** A display is closing — drop it immediately so the dot goes offline at once. */
export function displayLeaving(outputId: string): void {
  if (outputId.length > MAX_ID_LENGTH) return;
  const at = lastSeen.get(outputId);
  if (at === undefined) return;
  lastSeen.delete(outputId);
  departed.set(outputId, at);
  if (departed.size > DEPARTED_MAX) {
    const oldest = departed.keys().next().value;
    if (oldest !== undefined) departed.delete(oldest);
  }
  maybeBroadcast();
}
