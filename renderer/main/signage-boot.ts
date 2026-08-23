// signage-boot.ts — the one thing a screen has to remember to start with no
// server at all.
//
// Every kiosk surface but one is a window onto server state: with no /api/state
// there is nothing for a slots or dashboard screen to draw, and the honest
// answer is the "could not load" screen. Signage is the exception. It holds its
// own plan and its own media, and the whole offline claim rests on a screen
// coming back after a power cut with nothing on the network — so the shell has
// to know it is a signage screen BEFORE it has asked anybody.
//
// localStorage rather than the IndexedDB the horizon lives in, for one reason:
// this is read during the first render. An async read answers after the shell
// has already drawn the error screen, which is the failure being fixed.

const KEY = "stage:signage-screen";

export interface SignageBootRecord {
  /** The path this screen was being shown at, without slashes: "display-9". */
  path: string;
  /** The output's canonical id. A screen may be visited at a friendly slug, and
   *  the persisted plan — and everything else — is keyed by id, never by slug. */
  outputId: string;
  /**
   * Degrees clockwise the panel is mounted at.
   *
   * Here for the same reason the output id is: it is something the screen has
   * to know BEFORE it has heard from anybody. A portrait TV coming up after a
   * power cut has to come up portrait, and the server that would have said so
   * is the thing that is missing.
   */
  rotation?: number;
}

/** A kiosk device's own URL. It always opens `/enroll?device=<id>` and is
 *  redirected from there, so with the server gone this is the path a Pi is
 *  actually sitting on — the redirect never happens. */
const DEVICE_PATH = "enroll";

function normalise(pathSlug: string): string {
  return pathSlug.replace(/^\/+|\/+$/g, "").trim().toLowerCase();
}

/** What this browser last played signage on, or null. */
export function readSignageBoot(): SignageBootRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { path?: unknown; outputId?: unknown; rotation?: unknown };
    if (typeof parsed.path !== "string" || typeof parsed.outputId !== "string") return null;
    if (!parsed.path || !parsed.outputId) return null;
    const rotation =
      parsed.rotation === 90 || parsed.rotation === 180 || parsed.rotation === 270
        ? parsed.rotation
        : 0;
    return { path: parsed.path, outputId: parsed.outputId, rotation };
  } catch {
    // Unreadable or malformed reads the same as "nothing remembered", which the
    // caller already handles: wait for the server like every other screen.
    return null;
  }
}

/**
 * Record that this path is showing signage for this output.
 *
 * Returns false when the browser refused to store it — the caller is then
 * holding a screen that will NOT come back on its own, which is worth saying
 * out loud rather than discovering after a power cut.
 */
export function rememberSignageBoot(
  pathSlug: string,
  outputId: string,
  rotation = 0,
): boolean {
  try {
    const record: SignageBootRecord = { path: normalise(pathSlug), outputId, rotation };
    localStorage.setItem(KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the record if it belongs to this path — this screen is not signage any
 * more.
 *
 * Scoped to the path on purpose. There is one record per browser profile, which
 * is right for a kiosk device showing one screen; without this check, opening a
 * slots display in the same browser would quietly erase the signage screen's
 * ability to come back offline.
 */
export function forgetSignageBoot(pathSlug: string): boolean {
  const record = readSignageBoot();
  if (!record || record.path !== normalise(pathSlug)) return true;
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** A kiosk device's own URL — the path a Pi is sitting on when the server that
 *  would have redirected it is gone. */
export function isDevicePath(pathSlug: string): boolean {
  return normalise(pathSlug) === DEVICE_PATH;
}

/**
 * The output whose signage this path should start playing before it has heard
 * from a server, or null to wait like any other screen.
 *
 * One record per browser profile, not one per path, because a kiosk device is
 * dedicated to a single screen and the path it boots at (`/enroll`) is not the
 * path it ends up on. Matching the remembered path as well keeps a browser that
 * merely visited a signage screen once from answering for a different display.
 */
export function signageBootOutput(
  pathSlug: string,
  record: SignageBootRecord | null,
): string | null {
  if (!record) return null;
  const slug = normalise(pathSlug);
  if (slug === record.path) return record.outputId;
  if (slug === DEVICE_PATH) return record.outputId;
  return null;
}
