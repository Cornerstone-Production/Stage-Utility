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
// the Settings → Screens page can light a per-display Connected/Offline dot.

import { broadcast } from "./broadcaster.js";

// Longest tolerated gap before an output is considered gone. Must exceed the
// slow client heartbeat (60s) plus jitter/grace, or a quiet display would flap.
const TTL_MS = 90_000;
const SWEEP_MS = 30_000;

const lastSeen = new Map<string, number>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lastSig = "";

function connectedNow(): string[] {
  const cutoff = Date.now() - TTL_MS;
  const out: string[] = [];
  for (const [id, t] of lastSeen) if (t >= cutoff) out.push(id);
  return out.sort();
}

/** Current connected-output snapshot — pushed to a client when its SSE opens. */
export function presenceSnapshot(): { connected: string[] } {
  return { connected: connectedNow() };
}

// Broadcast only when the connected set actually changes (change-driven, per the
// house SSE efficiency rule) — heartbeats themselves are silent.
function maybeBroadcast(): void {
  const conn = connectedNow();
  const sig = conn.join(",");
  if (sig === lastSig) return;
  lastSig = sig;
  broadcast("displays:presence", { connected: conn });
}

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    maybeBroadcast();
    if (lastSeen.size === 0) {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_MS);
  // Don't hold the event loop open for the sweep alone.
  sweepTimer.unref?.();
}

/** Record a heartbeat from a display output. */
export function displayHeartbeat(outputId: string): void {
  lastSeen.set(outputId, Date.now());
  ensureSweep();
  maybeBroadcast();
}

/** A display is closing — drop it immediately so the dot goes offline at once. */
export function displayLeaving(outputId: string): void {
  if (lastSeen.delete(outputId)) maybeBroadcast();
}
