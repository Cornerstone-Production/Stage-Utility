// branding-image-store.ts — the app logo, empty-slot logo, default avatar and app icon, kept
// as files rather than base64 inside settings.
//
// They used to live inline, which cost twice over. Two of them ride in stage:state,
// so 168 KB of base64 was re-sent to every display on every state change — 77% of
// the whole payload — where a URL is forty bytes and is fetched once and cached
// forever. And settings.json was 435 KB of which 431 KB was image data, so patching
// a single boolean re-serialised the lot.
//
// The stored value is a `/branding-images/<hash>.<ext>` URL. `<img src>` accepts it
// exactly as it accepted a data URL, so nothing downstream had to change.

import { isDataUrl, readImage, saveImage } from "./image-files.js";
import type { SettingsData } from "./settings-store.js";

export const BRANDING_IMAGE_DIR = "branding-images";

/** Settings keys that hold an image. The `Original` ones are the pre-crop uploads
 *  kept for re-editing; they never reach stage:state but did bloat every write. */
export const BRANDING_IMAGE_KEYS = [
  "appLogo",
  "appLogoOriginal",
  "emptySlotLogo",
  "emptySlotLogoOriginal",
  "defaultAvatar",
  "defaultAvatarOriginal",
  // The custom tab and home-screen icon: the art it is drawn from, that art's
  // pre-crop upload, and the four sizes served to browsers and phones.
  "appIcon",
  "appIconOriginal",
  "appIconApple",
  "appIcon192",
  "appIcon512",
  "appIconMaskable",
] as const;

export type BrandingImageKey = (typeof BRANDING_IMAGE_KEYS)[number];

/** The shape of a reference this store hands out: `/branding-images/<hash>.<ext>`. */
const STORED_REF = /^\/branding-images\/([0-9a-f]{16}\.(?:png|jpg|gif|webp|svg))$/;

/** True when `v` is a reference to an image this store holds. */
export async function isStoredBrandingImage(v: unknown): Promise<boolean> {
  const m = typeof v === "string" ? STORED_REF.exec(v) : null;
  return m !== null && (await readImage(BRANDING_IMAGE_DIR, m[1]!)) !== null;
}

/** True when `v` has the shape of a stored reference, whether or not the file is there. */
export function looksLikeStoredRef(v: unknown): v is string {
  return typeof v === "string" && STORED_REF.test(v);
}

/** The longest data URL a branding image may arrive as (~1.5 MB of image). */
export const MAX_BRANDING_DATA_URL_CHARS = 2_000_000;

/**
 * Why `v` is not a branding image value a save takes, or null when it is: null,
 * an image data URL within the cap, or — where `storedRefAllowed` — the shape of
 * a stored reference. POST /api/branding allows a reference only for the
 * `*Original` fields (and then checks the file is here); settings.json holds a
 * reference for every field once it is saved, so a restore allows it for all.
 */
export function brandingImageProblem(v: unknown, storedRefAllowed: boolean): string | null {
  if (v === null) return null;
  if (storedRefAllowed && looksLikeStoredRef(v)) return null;
  if (!isDataUrl(v)) return `must be an image data URL${storedRefAllowed ? ", a stored image" : ""} or null`;
  if (v.length > MAX_BRANDING_DATA_URL_CHARS) return "is too large (max ~1.5 MB)";
  return null;
}

/** Store a data URL and return its reference. A value that is already a reference
 *  (or null) passes through untouched, so this is safe to call on every write. */
export async function externalizeImage(value: unknown): Promise<unknown> {
  if (!isDataUrl(value)) return value;
  return saveImage(BRANDING_IMAGE_DIR, value);
}

/**
 * Replace any inline image in a settings patch with a stored reference.
 *
 * Called on the way into `settingsStore.patch`, so bytes never reach the JSON no
 * matter which route or migration produced them.
 */
export async function externalizeBrandingImages<T extends Record<string, unknown>>(patch: T): Promise<T> {
  const out: Record<string, unknown> = { ...patch };
  for (const key of BRANDING_IMAGE_KEYS) {
    if (key in out) out[key] = await externalizeImage(out[key]);
  }
  return out as T;
}

/**
 * One-time migration for installs whose settings still hold base64.
 *
 * Returns the keys that were converted, or an empty array when there was nothing
 * inline — which is the steady state, so this costs one object scan on boot.
 */
export async function migrateInlineBrandingImages(
  settings: SettingsData,
): Promise<{ patch: Record<string, unknown>; converted: BrandingImageKey[] }> {
  const patch: Record<string, unknown> = {};
  const converted: BrandingImageKey[] = [];
  for (const key of BRANDING_IMAGE_KEYS) {
    const v = (settings as unknown as Record<string, unknown>)[key];
    if (!isDataUrl(v)) continue;
    try {
      patch[key] = await saveImage(BRANDING_IMAGE_DIR, v);
      converted.push(key);
    } catch (err) {
      // A malformed image must not block boot. Leaving it inline is exactly the
      // old behaviour, so the app still works — just without the saving.
      console.error(`[branding] could not externalize ${key}:`, err instanceof Error ? err.message : err);
    }
  }
  return { patch, converted };
}
