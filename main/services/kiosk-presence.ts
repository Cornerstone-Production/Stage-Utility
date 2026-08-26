// Which kiosk devices are shouting on the network right now.
//
// RUNTIME, deliberately: in memory, TTL'd, gone on restart, never written to
// disk. That is not an optimisation — it is the behaviour. An unclaimed device
// exists only while it is actually probing, so powering a Pi off before pairing
// it makes it vanish from every server's list with nothing to clean up. The
// bindings that DO survive live in kiosk-devices-store.ts.
//
// Modelled on display-presence.ts, which does the same job for kiosk pages.

import { broadcast } from "./broadcaster.js";
import { mergeScreen, sameScreen } from "./kiosk-screen-size.js";
import type { SeenDevice } from "../types/kiosk.js";

/** Longest gap before a device is considered gone. The agent probes every 2s and
 *  backs off to 30s once it has been ignored a while, so this must clear the
 *  slow end plus jitter or a quiet device would flap in and out of the list. */
const TTL_MS = 90_000;
const SWEEP_MS = 15_000;

/** How long a scan stays open when somebody presses the button. Long enough to
 *  walk to a screen and back, short enough that leaving it on is not a habit. */
export const SCAN_WINDOW_MS = 60_000;

/** An unknown device is recorded at most this often, so a misconfigured or
 *  malicious box cannot fill the list faster than a person can read it. */
const RECORD_EVERY_MS = 60_000;

const seen = new Map<string, SeenDevice>();
const lastRecorded = new Map<string, number>();

/**
 * Device secrets, kept OUT of the device record on purpose.
 *
 * A secret used to be a field on SeenDevice, and SeenDevice is what
 * `kiosk:devices` broadcasts — so every device secret went out over an SSE that
 * anything on the LAN can open, which is the one thing separating a claimed
 * display from any other machine. `/api/devices` stripped it and the broadcast
 * did not; a field that must be removed on the way out is a field in the wrong
 * place. Here it cannot be shipped by forgetting to strip it.
 *
 * A secret arriving for an unknown device also must not conjure a row on the
 * Screens page — /enroll is a GET, reachable by anything on the network — so it
 * is remembered without recording a sighting.
 */
const secrets = new Map<string, string>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lastSig = "";

/** Open scans, by holder. A page holds one while it is on screen; the button
 *  opens one that expires. Scanning is "any of these is still live". */
const scans = new Map<string, number>();

/** Is a scan open right now?
 *
 *  A pure read — it does NOT prune expired holders. It used to, and that made a
 *  predicate mutate: any caller passing a timestamp other than the wall clock
 *  (a test, or a sweep reasoning about a moment) silently deleted live scans.
 *  Pruning belongs to the sweep. */
export function scanning(now = Date.now()): boolean {
  for (const until of scans.values()) if (until > now) return true;
  return false;
}

/** Open a scan window. `holder` lets the Screens page hold one open for as long
 *  as it is mounted without fighting the button's fixed-length window. */
export function startScan(holder = "manual", ms = SCAN_WINDOW_MS, now = Date.now()): void {
  scans.set(holder, now + ms);
  ensureSweep();
  announce(now);
}

/** Close a scan early — the button's Stop, or the page unmounting. */
export function stopScan(holder = "manual"): void {
  if (scans.delete(holder)) announce();

}

/** Record a device we just heard from. Returns false when rate-limited. */
export function recordSeen(
  d: Omit<SeenDevice, "firstSeen" | "lastSeen">,
  now = Date.now(),
): boolean {
  const existing = seen.get(d.id);
  if (!existing) {
    const last = lastRecorded.get(d.id) ?? 0;
    if (now - last < RECORD_EVERY_MS && last !== 0) return false;
    lastRecorded.set(d.id, now);
    seen.set(d.id, { ...d, firstSeen: now, lastSeen: now });
    ensureSweep();
    announce(now);
    return true;
  }
  // Known device: refresh cheaply. Only announce when something a person would
  // notice changed — a probe every two seconds must not become an SSE every two
  // seconds, per the house rule about change-driven broadcasts.
  // Merge the screen rather than replace it — the probe only ever carries the
  // DRM mode and the holding screen only ever reports CSS pixels.
  const screen = mergeScreen(existing.screen, d.screen);
  const changed =
    existing.ip !== d.ip ||
    existing.boundTo !== d.boundTo ||
    !!existing.unreachable !== !!d.unreachable ||
    existing.hostname !== d.hostname ||
    !sameScreen(existing.screen, screen);
  seen.set(d.id, { ...existing, ...d, screen, lastSeen: now });
  if (changed) announce(now);
  return true;
}

/** Everything currently heard, freshest first. */
export function seenDevices(now = Date.now()): SeenDevice[] {
  const cutoff = now - TTL_MS;
  return [...seen.values()].filter((d) => d.lastSeen >= cutoff).sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Record the secret a device presented over HTTP. Never comes from a probe —
 *  a broadcast secret is not a secret. */
export function rememberSecret(id: string, secret: string): void {
  secrets.set(id, secret);
}

/** The secret a device presented, for pinning at claim. */
export function secretFor(id: string): string | undefined {
  return secrets.get(id);
}

/** Record the size a device reported over HTTP from its holding screen. Merged
 *  rather than replaced, so it does not wipe the physical mode the probe carried.
 *  A device that has not been heard from over UDP yet is not invented here — an
 *  unsolicited size for an unknown id would put a row on the page that no probe
 *  ever backed. */
export function rememberScreen(id: string, size: { w: number; h: number; dpr?: number }): void {
  const d = seen.get(id);
  if (!d) return;
  const next = mergeScreen(d.screen, size);
  if (sameScreen(d.screen, next)) return;
  seen.set(id, { ...d, screen: next });
  announce();
}

/** Forget a device immediately — it was just claimed, so it stops being a
 *  candidate the moment the binding exists rather than a minute and a half later. */
export function forgetSeen(id: string): void {
  secrets.delete(id);
  if (seen.delete(id)) announce();
}

/**
 * What a subscriber is shown — and, being the same value, what "did anything
 * change" is decided on.
 *
 * The signature used to be a hand-written list of fields, and it had fallen
 * behind the payload: a device's ip, hostname and screen size all set the
 * change flag and were then swallowed here, so a size reported while somebody
 * had Screens open never reached the page. A dedupe key derived from anything
 * other than the payload drifts from it; this one cannot.
 *
 * `lastSeen` is excluded deliberately — it changes on every probe, and including
 * it would turn a two-second heartbeat into a two-second broadcast.
 */
function payload(now: number): { scanning: boolean; seen: SeenDevice[] } {
  return { scanning: scanning(now), seen: seenDevices(now) };
}

/**
 * Force a `kiosk:devices` frame regardless of the dedupe.
 *
 * For changes this module cannot see — a claim, a release, a bound device's size
 * — which live in the persisted store. Screens refetches the whole listing on
 * this channel, so one channel serves both halves of the page rather than the
 * renderer having to subscribe to two.
 */
export function announceDevices(): void {
  lastSig = "";
  announce();
}

function announce(now = Date.now()): void {
  const next = payload(now);
  const sig = JSON.stringify({
    scanning: next.scanning,
    seen: next.seen.map(({ lastSeen: _l, firstSeen: _f, ...rest }) => rest),
  });
  if (sig === lastSig) return;
  lastSig = sig;
  broadcast("kiosk:devices", next);
}

/** Snapshot for a client whose SSE has just opened. */
export function kioskPresenceSnapshot(): { scanning: boolean; seen: SeenDevice[] } {
  return payload(Date.now());
}

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    // The sweep is what prunes expired scans — see scanning().
    const now = Date.now();
    for (const [holder, until] of scans) if (until <= now) scans.delete(holder);
    announce(now);
    if (seen.size === 0 && scans.size === 0) {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_MS);
  // Never hold the process open for a sweep alone.
  sweepTimer.unref?.();
}

/** Tests only: drop all state so cases cannot leak into each other. */
export function resetKioskPresence(): void {
  secrets.clear();
  seen.clear();
  lastRecorded.clear();
  scans.clear();
  lastSig = "";
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
