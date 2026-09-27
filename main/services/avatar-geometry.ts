// avatar-geometry.ts — the size and shape of a Planning Center photo.
//
// PCO serves every avatar through one resizer, driven by a `g=WxH` query param:
// `g=512x512` fits the image inside 512x512, and a trailing `#` (sent as `%23`)
// crops to exactly that shape instead. Without `g` it serves the original, which
// is ~1000px and, for a PNG upload, over 1 MB. The param is not in PCO's public
// API docs; the behaviour here was measured against avatars.planningcenteronline.com.

const GEOMETRY = /([?&]g=)(\d+)x(\d+)(%23|#)?/;

/** `url` with its PCO geometry set to `geometry`, replacing one or appending one. */
export function setAvatarGeometry(url: string, geometry: string): string {
  return GEOMETRY.test(url)
    ? url.replace(GEOMETRY, `$1${geometry}`)
    : url + (url.includes("?") ? "&" : "?") + `g=${geometry}`;
}
