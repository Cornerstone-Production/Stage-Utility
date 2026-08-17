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

/** When the current scan ends, or null. For the "Scanning — 42s left" readout. */
export function scanEndsAt(now = Date.now()): number | null {
  let latest: number | null = null;
  for (const until of scans.values()) if (until > now && (latest === null || until > latest)) latest = until;
  return latest;
}

/** Open a scan window. `holder` lets the Devices page hold one open for as long
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
  const changed =
    existing.ip !== d.ip ||
    existing.boundTo !== d.boundTo ||
    !!existing.unreachable !== !!d.unreachable ||
    existing.hostname !== d.hostname;
  seen.set(d.id, { ...existing, ...d, lastSeen: now });
  if (changed) announce(now);
  return true;
}

/** Everything currently heard, freshest first. */
export function seenDevices(now = Date.now()): SeenDevice[] {
  const cutoff = now - TTL_MS;
  return [...seen.values()].filter((d) => d.lastSeen >= cutoff).sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Forget a device immediately — it was just claimed, so it stops being a
 *  candidate the moment the binding exists rather than a minute and a half later. */
export function forgetSeen(id: string): void {
  if (seen.delete(id)) announce();
}

function signature(now: number): string {
  return `${scanning(now) ? "1" : "0"}|${seenDevices(now).map((d) => `${d.id}:${d.boundTo ?? ""}:${d.unreachable ? 1 : 0}`).join(",")}`;
}

function announce(now = Date.now()): void {
  const sig = signature(now);
  if (sig === lastSig) return;
  lastSig = sig;
  broadcast("kiosk:devices", { scanning: scanning(now), scanEndsAt: scanEndsAt(now), seen: seenDevices(now) });
}

/** Snapshot for a client whose SSE has just opened. */
export function kioskPresenceSnapshot(): {
  scanning: boolean;
  scanEndsAt: number | null;
  seen: SeenDevice[];
} {
  return { scanning: scanning(), scanEndsAt: scanEndsAt(), seen: seenDevices() };
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
  seen.clear();
  lastRecorded.clear();
  scans.clear();
  lastSig = "";
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
