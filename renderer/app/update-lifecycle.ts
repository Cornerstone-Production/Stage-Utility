// The in-app update handshake that spans a server restart.
//
// Extracted from settings-view.tsx. Module-scoped rather than component state
// because it has to survive a route change: the operator can press "Update now"
// in Advanced and navigate away while it applies, and the completion signal must
// still be recognised. There is exactly one server and one page, so one module
// holding this is correct rather than a shortcut.
//
// Two signals report completion and either may arrive first:
//   - server:hello carrying a version different from the one we started at
//     (fast path), and
//   - update:status returning to a non-"updating" phase after the restart
//     (durable path — survives a missed hello, because that channel re-hydrates
//     on every SSE reconnect).
// `reloadScheduled` makes them idempotent so they cannot double-reload.

/** sessionStorage, not local: the handshake is scoped to this tab. */
const UPDATE_PENDING_KEY = "stageUtility.update.pending";
const UPDATE_DONE_KEY = "stageUtility.update.done";

/** The running server's code version, captured from the first server:hello. */
let serverVersion: string | null = null;
let reloadScheduled = false;

export function noteServerVersion(version: string): void {
  if (serverVersion === null) serverVersion = version;
}

export function currentServerVersion(): string | null {
  return serverVersion;
}

/** Record which version we are updating FROM, so a later hello can tell us it finished. */
export function markUpdatePending(): void {
  try {
    sessionStorage.setItem(
      UPDATE_PENDING_KEY,
      JSON.stringify({ fromVersion: serverVersion, at: Date.now() }),
    );
  } catch {
    // sessionStorage unavailable — the durable update:status path still works;
    // only the faster server:hello comparison is lost.
  }
}

export function pendingUpdate(): { fromVersion: string | null } | null {
  try {
    const raw = sessionStorage.getItem(UPDATE_PENDING_KEY);
    return raw ? (JSON.parse(raw) as { fromVersion: string | null }) : null;
  } catch {
    return null;
  }
}

export function clearUpdatePending(): void {
  try {
    sessionStorage.removeItem(UPDATE_PENDING_KEY);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}

/**
 * The update we started has finished and the new build is live: record the
 * success banner and reload once to swap in the new assets.
 *
 * Idempotent — the two completion signals race, and reloading twice would drop
 * the banner the first reload was meant to show.
 */
export function finishUpdateAndReload(version: string | null): void {
  if (reloadScheduled) return;
  reloadScheduled = true;
  try {
    sessionStorage.removeItem(UPDATE_PENDING_KEY);
    if (version) sessionStorage.setItem(UPDATE_DONE_KEY, JSON.stringify({ version }));
  } catch {
    /* the reload still needs to happen; only the banner is lost */
  }
  // Brief beat so the "restarting" step paints before the reload.
  setTimeout(() => window.location.reload(), 900);
}

/**
 * The success banner left behind by the pre-restart page, read once.
 *
 * Consuming it here is deliberate: it must show exactly once, not on every
 * subsequent navigation within the same tab.
 */
export function takeJustUpdated(): { version: string } | null {
  try {
    const raw = sessionStorage.getItem(UPDATE_DONE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(UPDATE_DONE_KEY);
    return JSON.parse(raw) as { version: string };
  } catch {
    return null;
  }
}

/** Test seam — resets the module's one-shot guard between cases. */
export function __resetForTests(): void {
  serverVersion = null;
  reloadScheduled = false;
}
