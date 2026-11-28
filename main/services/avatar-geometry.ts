// avatar-geometry.ts — the size and shape of a Planning Center photo.
//
// PCO serves every avatar through one resizer, driven by a `g=WxH` query param:
// `g=512x512` fits the image inside 512x512, and a trailing `#` (sent as `%23`)
// crops to exactly that shape instead. Without `g` it serves the original, which
// is ~1000px and, for a PNG upload, over 1 MB. The param is not in PCO's public
// API docs; the behaviour here was measured against avatars.planningcenteronline.com.
//
// Pure, no Node imports: the renderer reads the size ladder from here too, so
// the sizes a display asks for and the sizes the proxy serves cannot drift.

/**
 * The sizes a display may ask for, as the longest side in device pixels.
 *
 * A fixed ladder rather than any number: every rung is another copy on disk and
 * another fetch from PCO, so a client asking for 257, 258, 259 as a box resizes
 * must land on one entry, not three. Steps of about 1.5x keep the overshoot
 * (and the bytes, which grow with the square of it) small.
 *
 * Nothing above 768: past that a box wants the whole geometry the server chose,
 * which tops out at 1000.
 */
export const PHOTO_SIZES = [128, 192, 256, 384, 512, 768] as const;

/**
 * The smallest size on the ladder that covers `px` device pixels.
 *
 * Null when `px` is over the top rung, or is not a positive number: the caller
 * then gets the photo at the geometry it was given, which is what every request
 * got before sizes existed.
 */
export function photoSizeFor(px: number): number | null {
  if (!(px > 0)) return null;
  for (const size of PHOTO_SIZES) if (px <= size) return size;
  return null;
}

const GEOMETRY = /([?&]g=)(\d+)x(\d+)(%23|#)?/;

/** `url` with its PCO geometry set to `geometry`, replacing one or appending one. */
export function setAvatarGeometry(url: string, geometry: string): string {
  return GEOMETRY.test(url)
    ? url.replace(GEOMETRY, `$1${geometry}`)
    : url + (url.includes("?") ? "&" : "?") + `g=${geometry}`;
}

/**
 * `url` scaled so the image's longest side is at most `size`, keeping its shape.
 *
 * The server has already chosen a geometry for where the photo is drawn — a
 * column crop for a display, the whole image where it cannot know the box (see
 * AvatarFit in slot-resolver.ts). This only makes that smaller: a crop stays the
 * same crop at fewer pixels, a fit-inside stays a fit-inside. It never enlarges
 * past what the server asked for, so a size larger than the geometry returns the
 * URL unchanged — the same bytes, the same cache entry.
 *
 * A URL with no geometry is the original upload, so it gets a fit-inside box.
 */
export function downscaleAvatarUrl(url: string, size: number): string {
  const m = GEOMETRY.exec(url);
  if (!m) return setAvatarGeometry(url, `${size}x${size}`);
  const w = Number(m[2]);
  const h = Number(m[3]);
  const scale = size / Math.max(w, h);
  if (!(scale < 1)) return url;
  // Never 0: PCO answers `g=0x0` with a 1x1 pixel, not an error.
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  return setAvatarGeometry(url, `${sw}x${sh}${m[4] ? "%23" : ""}`);
}
