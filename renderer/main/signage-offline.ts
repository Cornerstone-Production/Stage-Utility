// signage-offline.ts — the pieces that let a signage screen survive a reboot.
//
// Every function here is FEATURE-DETECTED and returns a falsy result rather than
// throwing when the platform cannot do it. That is not defensive habit: the
// service worker needs a secure context, which plain HTTP on a LAN is not, so on
// a phone or a browser tab none of this exists — and everything in the rest of
// signage still works, just without surviving a reload.
//
// On a Pi the kiosk launcher passes
// `--unsafely-treat-insecure-origin-as-secure`, which makes that one origin a
// secure context without a certificate. See scripts/kiosk/install-linux.sh.

import type { SignageHorizon } from "@main/types/signage";

const DB_NAME = "stage-signage";
const STORE = "horizons";

/** Is this browser able to keep a signage screen alive without a server? */
export function offlineCapable(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext;
}

/**
 * Register the worker, and ask for storage that will not be evicted.
 *
 * Returns false where the platform cannot — never throws. A screen that cannot
 * do this is a screen that works normally and loses only reload survival, which
 * is not worth an error on a wall.
 */
export async function registerSignageWorker(): Promise<boolean> {
  if (!offlineCapable()) return false;
  try {
    await navigator.serviceWorker.register("/signage-sw.js", { scope: "/" });
    // Without this, Chromium may evict the cache under storage pressure — which
    // on a Pi that has been running for months is exactly when it is needed.
    await navigator.storage?.persist?.();
    // Tell the worker to refresh the shell it will serve after a power cut.
    //
    // Asked for HERE, and only here, because this runs on a signage screen: the
    // page knows it is the kiosk document. The worker does not — this app ships
    // two shells (kiosk index.html, operator app.html), and a worker that cached
    // whatever navigation it saw last would answer a reboot with whichever one
    // was opened most recently. Preparing a Pi means opening the Signage tab on
    // that Pi, so the operator shell is not a corner case.
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    reg?.active?.postMessage({ type: "signage:shell" });
    return true;
  } catch (err) {
    console.error("[signage] could not register the offline worker:", err);
    return false;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    // Resolves null rather than rejecting: a screen with no IndexedDB (private
    // browsing, a locked-down profile) should still play, just not across a boot.
    req.onerror = () => resolve(null);
  });
}

/** Keep this screen's plan, so a cold boot has something to play. */
export async function persistHorizon(outputId: string, horizon: SignageHorizon): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(horizon, outputId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.error("[signage] could not persist the horizon:", tx.error);
      resolve();
    };
  });
  db.close();
}

/** The plan this screen last held, or null. */
export async function loadPersistedHorizon(outputId: string): Promise<SignageHorizon | null> {
  const db = await openDb();
  if (!db) return null;
  const value = await new Promise<SignageHorizon | null>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(outputId);
    req.onsuccess = () => resolve((req.result as SignageHorizon) ?? null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return value;
}

/** Ask the worker to hold these assets, and report what it actually holds. */
export async function precache(
  urls: string[],
): Promise<{ cached: number; total: number; failed: { url: string; error: string }[] } | null> {
  if (!offlineCapable()) return null;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const worker = reg?.active;
  if (!worker) return null;

  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "signage:precache-done") return;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve({ cached: e.data.cached, total: e.data.total, failed: e.data.failed ?? [] });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    worker.postMessage({ type: "signage:precache", urls });

    // A worker that never answers must not leave the UI saying "preparing"
    // forever - the operator is standing there deciding whether to unplug a Pi.
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(null);
    }, 120_000);
  });
}
