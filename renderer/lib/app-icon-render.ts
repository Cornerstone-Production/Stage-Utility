// Draws the custom tab and home-screen icon: every size, from one square of art.
//
// Done in the browser because the server has no image library and does not need
// one for this. The operator crops a square in the usual editor; this lays it over
// the chosen background at each size a browser, an iPhone or an Android launcher
// asks for, and POST /api/branding checks that each PNG is the size it claims.
//
// What the canvas does (pixels, scaling quality, PNG encoding) is verified by
// driving Chrome. What is testable without one is WHERE the art goes at each size,
// which is `layoutIcon` and `drawIcon` over a recorded context.

import { clamp } from "@main/services/clamp";
import { ICON_SIZES, type IconField } from "@main/services/install-metadata";

/** The longest side the stored art is kept at: the largest icon is 512. */
export const ART_MAX = 512;

/** The share of a maskable icon's side that the art may occupy. Android crops the
 *  icon to a circle, a squircle or a rounded square of its own choosing; the spec
 *  guarantees only the centre 80% survives every one of them. */
export const MASKABLE_ART = 0.8;

/** Where the art lands in a `size` px icon: its side, and its top-left corner. */
export function layoutIcon(size: number, artFraction: number): { art: number; offset: number } {
  const art = Math.round(size * artFraction);
  return { art, offset: Math.round((size - art) / 2) };
}

/** The only parts of a 2D context `drawIcon` uses, so a test can record them. */
export interface IconContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  drawImage: (image: CanvasImageSource, x: number, y: number, w: number, h: number) => void;
}

/**
 * Fill the whole square with `background`, then lay the art over it.
 *
 * The background is filled edge to edge and never left transparent: iOS fills a
 * transparent home-screen icon with black, and Android fills a maskable one with
 * whatever the launcher likes.
 */
export function drawIcon(
  ctx: IconContext,
  art: CanvasImageSource,
  size: number,
  background: string,
  artFraction: number,
): void {
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);
  const { art: side, offset } = layoutIcon(size, artFraction);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(art, offset, offset, side, side);
}

/** The art fraction for each icon: the maskable one keeps clear of the edge. */
const ART_FRACTION: Record<IconField, number> = { apple: 1, any192: 1, any512: 1, maskable: MASKABLE_ART };

function canvasOf(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser has no 2D canvas, so the icon cannot be drawn");
  return { canvas, ctx };
}

/** Load an image from a data URL or a same-origin URL. Rejects when it cannot. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the image could not be loaded"));
    img.src = src;
  });
}

/**
 * The art as a square PNG no larger than ART_MAX, from any square-ish image.
 *
 * The logo cropper already exports a square, so this only brings a 1024 px export
 * down to the largest icon size (and a 256 px one is left alone, not blown up).
 */
export async function toIconArt(src: string): Promise<string> {
  const img = await loadImage(src);
  const side = Math.round(clamp(Math.min(img.naturalWidth || ART_MAX, img.naturalHeight || ART_MAX), 1, ART_MAX));
  const { canvas, ctx } = canvasOf(side);
  // Cover, centred: a source that is not quite square loses a sliver, never gets stretched.
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, side, side);
  return canvas.toDataURL("image/png");
}

/** Every size of the icon, as PNG data URLs, drawn from `art` over `background`. */
export async function renderIconSizes(art: string, background: string): Promise<Record<IconField, string>> {
  const img = await loadImage(art);
  const out = {} as Record<IconField, string>;
  for (const field of Object.keys(ICON_SIZES) as IconField[]) {
    const size = ICON_SIZES[field];
    const { canvas, ctx } = canvasOf(size);
    drawIcon(ctx, img, size, background, ART_FRACTION[field]);
    out[field] = canvas.toDataURL("image/png");
  }
  return out;
}
