// The ServiceCue text size: the numbers, and where one screen remembers its own.
//
// No React and no DOM globals beyond what `readStoredSize`/`writeStoredSize` are
// handed, so the stepping and the typed-value rules can be driven directly. The
// hook that holds the current size is use-servicecue-text-size.ts.
//
// The size is a percentage of the rundown's normal size. It scales the rundown
// only, never the header; see RundownTable's `textScale`.

// The range and the clamp are the server's too (a display's size is kept there),
// so they live in main/types/text-size.ts and are re-exported here.
import { clampTextSize, DEFAULT_TEXT_SIZE, MAX_TEXT_SIZE, MIN_TEXT_SIZE } from "@main/types/text-size";
export { clampTextSize, DEFAULT_TEXT_SIZE, MAX_TEXT_SIZE, MIN_TEXT_SIZE };

export const TEXT_SIZE_STEP = 10;

/**
 * One A+ or A- press.
 *
 * Lands on the next multiple of ten in the direction pressed, so a typed 137
 * steps to 140 going up and 130 going down rather than to 147 or 127. A value
 * already on a multiple of ten moves by exactly ten.
 */
export function stepTextSize(size: number, direction: -1 | 1): number {
  const next =
    direction > 0
      ? Math.floor(size / TEXT_SIZE_STEP) * TEXT_SIZE_STEP + TEXT_SIZE_STEP
      : Math.ceil(size / TEXT_SIZE_STEP) * TEXT_SIZE_STEP - TEXT_SIZE_STEP;
  return clampTextSize(next);
}

// An optional sign, digits with an optional fraction, an optional percent sign.
// Strict on purpose: "150abc" is not a size, and a parseFloat that read it as
// 150 would commit something the operator did not type.
const TYPED_SIZE = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*%?\s*$/;

/**
 * What a typed or linked size means: the number, rounded and clamped, or null
 * when it is not a number at all. Null is the signal to revert, so a typo
 * cannot change the size.
 */
export function parseTextSize(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const m = TYPED_SIZE.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? clampTextSize(n) : null;
}

/** The `?text=` search param, parsed the same way a typed value is. */
export function textSizeFromSearch(search: string): number | null {
  return parseTextSize(new URLSearchParams(search).get("text"));
}

export interface DisplayTextSizeInput {
  /** A settings preview of a screen (or of a View): it draws the screen's kept
   *  size and never changes it. */
  isPreview: boolean;
  /** The display's `?text=`, parsed, or null — null also once it has been kept. */
  fromAddress: number | null;
  /** The size the server keeps for this display, null when none is. */
  server: number | null;
  /** A size this device remembered for the display before the server kept one. */
  remembered: number | null;
}

/**
 * What a display draws, and what it should ask the server to keep.
 *
 * A size in the address is the operator's latest word and wins. With none, the
 * server's rules, so every device showing the display — and every preview of it
 * — agrees. A display the server holds nothing for hands over what this device
 * remembered, once: after that the server has a size and `remembered` is never
 * consulted again. `save` is null when the server already holds what is wanted,
 * so a display opened with the same `?text=` every boot writes nothing.
 */
export function displayTextSize(i: DisplayTextSizeInput): { show: number; save: number | null } {
  if (i.isPreview) return { show: clampTextSize(i.server ?? DEFAULT_TEXT_SIZE), save: null };
  const wanted = i.fromAddress ?? (i.server === null ? i.remembered : null);
  return {
    show: clampTextSize(wanted ?? i.server ?? DEFAULT_TEXT_SIZE),
    save: wanted !== null && wanted !== i.server ? wanted : null,
  };
}

/** The one key a screen's size is kept under. The page has its own, so a size
 *  set at the booth does not resize a display. A display's is only read now, to
 *  hand a size this device remembered to the server (see displayTextSize). */
const KEY_PREFIX = "servicecue-text-size:";
export const PAGE_TEXT_SIZE_KEY = `${KEY_PREFIX}page`;
export function displayTextSizeKey(displayId: string): string {
  return `${KEY_PREFIX}display:${displayId}`;
}

/** What these keys began with before ServiceCue was renamed. A display that
 *  had a size under the old key keeps it across the update. */
const LEGACY_KEY_PREFIX = "scriptview-text-size:";
function legacyKeyFor(key: string): string | null {
  return key.startsWith(KEY_PREFIX) ? `${LEGACY_KEY_PREFIX}${key.slice(KEY_PREFIX.length)}` : null;
}

export interface SizeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** The size remembered under `key`, or null when there is none or storage is
 *  unavailable. Read through parseTextSize, so a hand-edited value cannot put
 *  the rundown outside its range. */
export function readStoredSize(key: string, storage: SizeStorage | null = browserStorage()): number | null {
  if (!storage) return null;
  try {
    const legacy = legacyKeyFor(key);
    // The old key only answers when the new one has nothing usable. Nothing is
    // written here; adoptLegacyStoredSize does that, from an effect.
    return parseTextSize(storage.getItem(key)) ?? (legacy ? parseTextSize(storage.getItem(legacy)) : null);
  } catch {
    // Storage that throws (blocked cookies, a locked-down kiosk profile) is the
    // same answer as storage with nothing in it: no remembered size.
    return null;
  }
}

/**
 * Copy a size remembered under the pre-rename key to the current one, when the
 * current one has none. The old key is left where it is: it is the operator's
 * setting, and it costs nothing to keep. Returns whether it copied.
 *
 * Separate from readStoredSize because a render must not write; the hook calls
 * this from an effect.
 */
export function adoptLegacyStoredSize(key: string, storage: SizeStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  const legacy = legacyKeyFor(key);
  if (!legacy) return false;
  try {
    if (parseTextSize(storage.getItem(key)) != null) return false;
    const size = parseTextSize(storage.getItem(legacy));
    if (size == null) return false;
    storage.setItem(key, String(size));
    return true;
  } catch {
    // Blocked storage: the size is still read from the old key until a reload.
    return false;
  }
}

/** Remember `size`. Returns false when storage refused, which the callers
 *  accept: the size still applies until a reload, and a blocked storage is not
 *  something an operator can act on, so it is not logged. */
export function writeStoredSize(key: string, size: number, storage: SizeStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, String(size));
    return true;
  } catch {
    return false;
  }
}

function browserStorage(): SizeStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Merely touching `localStorage` throws where storage is blocked.
    return null;
  }
}
