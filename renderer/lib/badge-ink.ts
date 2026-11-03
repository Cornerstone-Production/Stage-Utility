/**
 * Picking readable ink for a badge that sits on a photo.
 *
 * The own-in-ears badge is a small circle in a card's top-right corner, over
 * whatever the performer's photo happens to show there. A fixed white-on-glass
 * badge vanishes on a white wall, so the badge samples the patch of photo it
 * covers once per loaded image and picks dark ink on a light patch, light ink on
 * a dark one.
 */

import { errorMessage } from "@main/services/errors";

export type BadgeInk = "light" | "dark";

/**
 * Relative luminance (WCAG, 0 = black, 1 = white) at which black and white ink
 * give equal contrast: L = sqrt(1.05 * 0.05) - 0.05. Above it black ink reads
 * better, below it white does.
 */
export const INK_CROSSOVER = Math.sqrt(1.05 * 0.05) - 0.05;

/** The ink to draw over a patch of the given relative luminance. */
export function inkForLuminance(luminance: number): BadgeInk {
  return luminance > INK_CROSSOVER ? "dark" : "light";
}

/** Linear-light relative luminance of an sRGB colour, channels 0..255. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a rectangle given in the photo BOX's coordinates lands in the image's own
 * pixels, for an image drawn object-fit: cover at the given object-position
 * (fractions, 0..1). Null when the box or image has no size, or the rectangle
 * falls wholly outside the image.
 */
export function boxRectToImageRect(
  patch: Rect,
  box: { width: number; height: number },
  natural: { width: number; height: number },
  position: { x: number; y: number },
): Rect | null {
  if (box.width <= 0 || box.height <= 0 || natural.width <= 0 || natural.height <= 0) return null;
  const scale = Math.max(box.width / natural.width, box.height / natural.height);
  const offsetX = (box.width - natural.width * scale) * position.x;
  const offsetY = (box.height - natural.height * scale) * position.y;
  const left = Math.max(0, (patch.left - offsetX) / scale);
  const top = Math.max(0, (patch.top - offsetY) / scale);
  const right = Math.min(natural.width, (patch.left + patch.width - offsetX) / scale);
  const bottom = Math.min(natural.height, (patch.top + patch.height - offsetY) / scale);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export type PatchLuminance = { ok: true; luminance: number } | { ok: false; reason: string };

const SAMPLE = 8;

/**
 * Average luminance of a patch of a loaded image, via a tiny canvas. Never throws:
 * an image that is not loaded, or whose pixels the browser will not hand over (a
 * tainted canvas), comes back as `{ ok: false, reason }` and the caller keeps its
 * neutral plate.
 */
export function sampleImagePatch(img: HTMLImageElement, source: Rect): PatchLuminance {
  try {
    if (!img.complete || img.naturalWidth === 0) return { ok: false, reason: "image not loaded" };
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { ok: false, reason: "no 2d canvas" };
    ctx.drawImage(img, source.left, source.top, source.width, source.height, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += relativeLuminance(data[i]!, data[i + 1]!, data[i + 2]!);
    return { ok: true, luminance: sum / (data.length / 4) };
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  }
}
