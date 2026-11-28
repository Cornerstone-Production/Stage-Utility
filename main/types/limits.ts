// limits.ts — size policies that more than one module has to agree on.
//
// A types module cannot import a service at runtime, so a limit the shared
// types need (the stage-plot upload limits) cannot live beside the code that
// enforces it. It lives here, and the services import it: raising a limit
// raises every check and every message built from it.

const MIB = 1024 * 1024;

/** The largest image kept (a layout image, a stage-plot background or a raster
 *  of one) and the largest photo the proxy will cache. */
export const MAX_IMAGE_BYTES = 12 * MIB;

/** The largest PDF upload. Above the image cap: a plan set exported from a
 *  drawing program is often bigger than a photo of it. */
export const MAX_PDF_BYTES = 25 * MIB;

/** The largest logo or icon image file the Branding settings take. */
export const MAX_LOGO_BYTES = 1_500_000;

/** The longest data URL a branding image may arrive as: the base64 of
 *  MAX_LOGO_BYTES (four characters for every three bytes). */
export const MAX_LOGO_DATA_URL_CHARS = (MAX_LOGO_BYTES / 3) * 4;

/** The logo limit as a refusal or a hint says it. */
export const LOGO_LIMIT_LABEL = "1.5 MB";

/** A size as an operator reads it in a refusal: `12 MB`. */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / MIB)} MB`;
}
