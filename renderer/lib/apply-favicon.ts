// Points the browser tab icon at the logo uploaded in Branding → Logo, and back
// at the stock icon when there is none. Called from the one place every surface
// adopts a StageState (use-stage-state.ts), exactly as applyAccentVar is, so the
// operator app and every kiosk display follow a logo change without a reload.
//
// The stored logo is already a square PNG: the Branding cropper always exports a
// square region, so there is nothing to letterbox.
//
// RECOLOR. With "Recolor to match theme" on (the default) the app draws the logo
// as a CSS mask filled with the theme's foreground, because a single-colour logo
// is usually white artwork meant for the dark kiosk. A tab cannot use a mask, so
// the same recolouring is done once on a canvas: the logo is rasterised and
// filled with the ink that contrasts with the browser's colour scheme, and the
// result is the tab icon. Without that, white ink vanishes on a light tab strip.
// With it off the logo is used exactly as uploaded.

/** The icon both HTML documents ship. apply-favicon.test.ts keeps them in step. */
export const STOCK_FAVICON = "/app-icon.png";

/** The app's own `--su-fg` in `:root` and `.dark` (renderer/styles.css). */
export const INK = { light: "#161b22", dark: "#ededf0" } as const;

const ICON_SIZE = 64;
const DARK_SCHEME = "(prefers-color-scheme: dark)";

/** Draws `logo` filled with `ink` and returns it as a PNG data URL. */
export type Rasterizer = (logo: string, ink: string) => Promise<string>;

/** Rejects, rather than returning something plausible, when it cannot recolor. */
const rasterizeInCanvas: Rasterizer = async (logo, ink) => {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  // Before loading the image: with no 2D context there is nothing to wait for.
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas context");
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("the logo image failed to load"));
    img.src = logo;
  });
  const w = img.naturalWidth || ICON_SIZE;
  const h = img.naturalHeight || ICON_SIZE;
  const scale = Math.min(ICON_SIZE / w, ICON_SIZE / h);
  ctx.drawImage(img, (ICON_SIZE - w * scale) / 2, (ICON_SIZE - h * scale) / 2, w * scale, h * scale);
  // source-in keeps the logo's alpha and replaces its colour: the same result
  // the CSS mask gives on the page.
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
  return canvas.toDataURL("image/png");
};

// ── State ─────────────────────────────────────────────────────────────────────

let rasterize: Rasterizer = rasterizeInCanvas;
/** The latest thing asked for, so a scheme change can redo it. */
let request: { logo: string | null; monochrome: boolean } = { logo: null, monochrome: false };
/** Bumped whenever the answer changes; a slow raster only lands if still current. */
let seq = 0;
/** Key of the raster currently in flight, so a repeat broadcast does not start another. */
let inflight: string | null = null;
/** (ink, logo) → the icon href. Bounded: a logo changes rarely. */
const cache = new Map<string, string>();
const CACHE_MAX = 4;
let scheme: MediaQueryList | null = null;

function prefersDark(): boolean {
  return scheme?.matches ?? false;
}

/** One listener for the page's life, started by the first call. */
function watchScheme(): void {
  if (scheme || typeof window.matchMedia !== "function") return;
  scheme = window.matchMedia(DARK_SCHEME);
  scheme.addEventListener("change", resolve);
}

/** The `<link rel="icon">` in the document head, created if a document has none. */
function iconLink(): HTMLLinkElement {
  const existing = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.appendChild(link);
  return link;
}

/** `raw` is a logo exactly as uploaded: its format is whatever it is. */
function setIcon(href: string, raw: boolean): void {
  const link = iconLink();
  // Called on every state broadcast. Re-assigning an identical href is not free:
  // some browsers refetch and repaint the tab icon for it.
  if (link.getAttribute("href") === href) return;
  // The HTML declares image/png, which is right for the stock icon, the cropper's
  // output and a recoloured icon, but a logo set through the API may be another
  // format, and a declared type that disagrees with the bytes makes a browser
  // skip the icon. Dropping it lets the browser read the response.
  if (raw) link.removeAttribute("type");
  else link.setAttribute("type", "image/png");
  link.setAttribute("href", href);
}

/** Settle on an answer that needs no raster, and cancel any raster still loading. */
function settle(href: string, raw: boolean): void {
  seq++;
  inflight = null;
  setIcon(href, raw);
}

function resolve(): void {
  const { logo, monochrome } = request;
  if (!logo) return settle(STOCK_FAVICON, false);
  if (!monochrome) return settle(logo, true);

  const ink = prefersDark() ? INK.dark : INK.light;
  const key = `${ink}|${logo}`;
  const hit = cache.get(key);
  if (hit) return settle(hit, hit === logo);
  if (inflight === key) return;

  const token = ++seq;
  inflight = key;
  const remember = (href: string) => {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, href);
    if (token !== seq) return; // a newer answer got here first
    inflight = null;
    setIcon(href, href === logo);
  };
  rasterize(logo, ink).then(remember, (err: unknown) => {
    // The tab still gets the logo, just not recoloured. Remembered as the answer
    // for this logo and ink so a failing image warns once, not on every broadcast.
    console.warn(
      "[branding] the tab icon could not be recolored; using the logo as uploaded:",
      err instanceof Error ? err.message : err,
    );
    remember(logo);
  });
}

/**
 * Set the tab icon for the current branding.
 *
 * @param appLogo     The uploaded logo URL, or null for the stock icon.
 * @param monochrome  Recolor to match theme: tint the logo to contrast with the
 *                    browser's colour scheme. False leaves it as uploaded.
 */
export function applyFavicon(appLogo: string | null | undefined, monochrome?: boolean): void {
  request = { logo: appLogo || null, monochrome: !!monochrome };
  watchScheme();
  resolve();
}

/** Test seam: forget everything, and swap the canvas for `fn` (null restores it). */
export function __resetForTests(fn: Rasterizer | null = null): void {
  scheme?.removeEventListener("change", resolve);
  scheme = null;
  request = { logo: null, monochrome: false };
  seq++;
  inflight = null;
  cache.clear();
  rasterize = fn ?? rasterizeInCanvas;
}
