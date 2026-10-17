// app-icon.ts — the custom tab and home-screen icon: what a request may carry, and
// what the server hands back for it.
//
// An icon is ONE thing made of five images. The operator uploads a square; the
// browser draws every size from it (there is no image library on the server, and
// none is wanted for this) and sends all of them together. The server's job is to
// refuse a set that would be served wrongly: a PNG that is not the size its name
// and the manifest promise, a size left out, a colour that is not a colour.
//
// Either every image is present or none is. Five optional keys would let a request
// set a 180 icon and leave a stale 512 one behind, which a phone then shows.

export interface IconCrop {
  scale: number;
  x: number;
  y: number;
}

/** What POST /api/branding takes as `icon`: the square art, the sizes drawn from
 *  it, and what they were drawn over. */
export interface AppIconInput {
  /** The square art itself, transparent where the upload was. Kept so a changed
   *  background can redraw the sizes without the operator uploading again. */
  art: string;
  /** The pre-crop upload, for Adjust. Null when it was built from the logo and no
   *  original exists, or arrived through the API. */
  original: string | null;
  crop: IconCrop | null;
  /** `#rrggbb`, filled behind transparent areas. */
  background: string;
  apple: string;
  any192: string;
  any512: string;
  maskable: string;
}

export const DEFAULT_ICON_BACKGROUND = "#000000";

/** The custom icon fields of the settings file, and the one place they are named. */
export interface AppIconSettings {
  appIcon: string | null;
  appIconOriginal: string | null;
  appIconCrop: IconCrop | null;
  appIconBackground: string;
  appIconApple: string | null;
  appIcon192: string | null;
  appIcon512: string | null;
  appIconMaskable: string | null;
}

/** The icon with nothing set. Spread into a settings patch to remove a custom icon. */
export const NO_APP_ICON: AppIconSettings = {
  appIcon: null,
  appIconOriginal: null,
  appIconCrop: null,
  appIconBackground: DEFAULT_ICON_BACKGROUND,
  appIconApple: null,
  appIcon192: null,
  appIcon512: null,
  appIconMaskable: null,
};

/** The public paths a custom icon is served at, and the settings field behind each.
 *  The paths are the ones the HTML documents and the manifest already name, so a
 *  custom icon needs no change to either beyond the app name. */
export const ICON_ROUTES = {
  "/apple-touch-icon.png": { field: "appIconApple", size: 180 },
  "/icon-192.png": { field: "appIcon192", size: 192 },
  "/icon-512.png": { field: "appIcon512", size: 512 },
  "/icon-maskable-512.png": { field: "appIconMaskable", size: 512 },
} as const satisfies Record<string, { field: keyof AppIconSettings; size: number }>;

export type IconRoutePath = keyof typeof ICON_ROUTES;

/** Each data URL is held to the cap the other branding images have. */
const MAX_DATA_URL_CHARS = 2_000_000;
const PNG_PREFIX = "data:image/png;base64,";

/** The pixel size an icon PNG declares, read from its IHDR; null if it is not a PNG. */
export function pngSize(dataUrl: string): { width: number; height: number } | null {
  if (!dataUrl.startsWith(PNG_PREFIX)) return null;
  // The first 24 bytes hold the signature, the IHDR chunk header, width and height.
  // 44 base64 characters decode to 33, so slicing there cannot cut a byte short.
  const head = Buffer.from(dataUrl.slice(PNG_PREFIX.length, PNG_PREFIX.length + 44), "base64");
  if (head.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => head[i] === b)) return null;
  if (head.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

export type IconParse = { ok: true; value: AppIconInput | null } | { ok: false; error: string };

function parseCrop(v: unknown): IconCrop | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  return typeof c.scale === "number" && typeof c.x === "number" && typeof c.y === "number"
    ? { scale: c.scale, x: c.x, y: c.y }
    : null;
}

/** The sizes the icon images must be, by request field. `art` only has to be square. */
const IMAGE_SIZES = { art: null, apple: 180, any192: 192, any512: 512, maskable: 512 } as const;

/** The reason a field is not an acceptable icon PNG, or null when it is. */
function pngProblem(key: keyof typeof IMAGE_SIZES, value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(PNG_PREFIX)) return `body.icon.${key} must be a PNG data URL`;
  if (value.length > MAX_DATA_URL_CHARS) return `body.icon.${key} too large (max ~1.5 MB)`;
  const dims = pngSize(value);
  if (!dims) return `body.icon.${key} is not a valid PNG`;
  const size = IMAGE_SIZES[key];
  if (size === null) return dims.width === dims.height ? null : `body.icon.${key} must be square`;
  return dims.width === size && dims.height === size
    ? null
    : `body.icon.${key} must be ${size} x ${size}, got ${dims.width} x ${dims.height}`;
}

/**
 * Check the `icon` field of a branding request.
 *
 * `null` is "remove the custom icon". Anything else must be a complete set, each
 * PNG the exact size it is served as. The error names the field, as the other
 * branding fields' do.
 */
export function parseAppIcon(v: unknown): IconParse {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "body.icon must be an object or null" };
  const body = v as Record<string, unknown>;

  for (const key of Object.keys(IMAGE_SIZES) as (keyof typeof IMAGE_SIZES)[]) {
    const problem = pngProblem(key, body[key]);
    if (problem) return { ok: false, error: problem };
  }

  const background = body.background;
  if (typeof background !== "string" || !/^#[0-9a-fA-F]{6}$/.test(background)) {
    return { ok: false, error: "body.icon.background must be a #rrggbb hex" };
  }

  let original: string | null = null;
  if (body.original !== null && body.original !== undefined) {
    if (typeof body.original !== "string" || !body.original.startsWith("data:image/")) {
      return { ok: false, error: "body.icon.original must be an image data URL or null" };
    }
    if (body.original.length > MAX_DATA_URL_CHARS) {
      return { ok: false, error: "body.icon.original too large (max ~1.5 MB)" };
    }
    original = body.original;
  }

  return {
    ok: true,
    value: {
      art: body.art as string,
      original,
      crop: parseCrop(body.crop),
      background: background.toLowerCase(),
      apple: body.apple as string,
      any192: body.any192 as string,
      any512: body.any512 as string,
      maskable: body.maskable as string,
    },
  };
}

/** The settings fields for a custom icon, from a validated request. Image fields
 *  are still data URLs here; the settings store turns them into stored files. */
export function iconToSettings(icon: AppIconInput): AppIconSettings {
  return {
    appIcon: icon.art,
    appIconOriginal: icon.original,
    appIconCrop: icon.crop,
    appIconBackground: icon.background,
    appIconApple: icon.apple,
    appIcon192: icon.any192,
    appIcon512: icon.any512,
    appIconMaskable: icon.maskable,
  };
}
