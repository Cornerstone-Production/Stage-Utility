// Which found screens this browser has dismissed from the Screens banner.
//
// A choice of the person at this browser: nothing on the server changes. It lives
// in one module-level store, not in the banner's own state, so that:
//   - Undo works from a toast that outlives the banner (leaving Screens unmounts
//     it, and a toast keeps counting down),
//   - two tabs agree, through the browser's `storage` event,
//   - a browser whose storage refuses writes still holds the dismissal for the
//     rest of the visit, and says it will not be remembered.
//
// Stored as `{ [deviceId]: dismissedAt }`, and entries older than 30 days are
// dropped when read: a device that was dismissed and never set up (a laptop that
// left) would otherwise leave its id here forever. The first shape stored a bare
// array of ids; those read as dismissed now.

import { useSyncExternalStore } from "react";
import { readStored, removeStored, writeStored } from "../../lib/safe-storage";

export const DISMISSED_KEY = "stage-utility-screens-dismissed-found";

/** How long a dismissal is kept. */
const DISMISSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Dismissed = ReadonlyMap<string, number>;

/**
 * The dismissals in storage, aged. Empty when storage is absent, throws, or holds
 * something unreadable: a banner that cannot remember must still draw. `ok` says
 * whether storage could be read at all.
 */
function readDismissed(now = Date.now()): { entries: Dismissed; ok: boolean } {
  return readStored<{ entries: Dismissed; ok: boolean }>(DISMISSED_KEY, (raw) => ({ entries: parseDismissed(raw, now), ok: true }), {
    entries: new Map<string, number>(),
    ok: false,
  });
}

/** The stored text as dismissals, aged. Empty for nothing stored or something unreadable. */
function parseDismissed(raw: string | null, now: number): Dismissed {
  const entries = new Map<string, number>();
  if (!raw) return entries;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries;
  }
  const keep = (id: string, at: number) => {
    if (now - at < DISMISSED_TTL_MS) entries.set(id, at);
  };
  if (Array.isArray(parsed)) {
    // The first shape: ids with no date. Dated now, so they age from this read.
    for (const id of parsed) if (typeof id === "string") keep(id, now);
  } else if (parsed && typeof parsed === "object") {
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) keep(id, at);
    }
  }
  return entries;
}

/** Keep the dismissals. Whether they were kept: false is a browser that will not
 *  remember them. */
function writeDismissed(entries: Dismissed): boolean {
  if (entries.size === 0) return removeStored(DISMISSED_KEY);
  return writeStored(DISMISSED_KEY, JSON.stringify(Object.fromEntries(entries)));
}

let cache: Dismissed | null = null;
let listening = false;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const s of subscribers) s();
}

function ensure(): Dismissed {
  if (cache) return cache;
  cache = readDismissed().entries;
  if (!listening && typeof window !== "undefined") {
    listening = true;
    // Another tab changed them. `key` is null when storage was cleared.
    window.addEventListener("storage", (e) => {
      if (e.key !== null && e.key !== DISMISSED_KEY) return;
      cache = readDismissed().entries;
      notify();
    });
  }
  return cache;
}

function commit(next: Dismissed): boolean {
  cache = next;
  const kept = writeDismissed(next);
  notify();
  return kept;
}

/** Tests only: forget the cached dismissals so the next read comes from storage. */
export function __resetDismissedForTests(): void {
  cache = null;
}

/**
 * Dismiss one device. Returns whether the browser kept it: when it did not, the
 * device is still hidden for the rest of this visit and the caller says it will
 * be back after a reload.
 */
export function dismissFound(id: string, now = Date.now()): boolean {
  return commit(new Map(ensure()).set(id, now));
}

/** Put some back (Undo, or devices that were set up). */
export function restoreFound(ids: readonly string[]): void {
  const have = ensure();
  if (!ids.some((id) => have.has(id))) return;
  const next = new Map(have);
  for (const id of ids) next.delete(id);
  commit(next);
}

/** Put every dismissed device back. */
export function restoreAllFound(): void {
  if (ensure().size > 0) commit(new Map());
}

const subscribe = (onChange: () => void): (() => void) => {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
};

/** The dismissed devices, live: another tab's change and Undo both reach it. */
export function useDismissed(): Dismissed {
  return useSyncExternalStore(subscribe, ensure);
}
