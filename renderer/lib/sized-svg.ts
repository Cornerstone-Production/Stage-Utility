// Gives an SVG the pixel size a browser needs to draw it onto a canvas.
//
// An SVG that declares only a viewBox, which is most of what design tools export,
// has no size of its own. Chrome answers naturalWidth/naturalHeight with 150 x 150
// for it, and then draws it onto a canvas at its viewBox scale rather than that
// size: cropping such a file with the editor's source rectangle (given in natural
// pixels) captured one corner of the artwork. Found by uploading a 200-unit-square
// SVG as an icon and seeing a quarter of it.
//
// Writing an explicit width and height on the root, in the aspect the artwork
// really has, makes the file behave like a raster: the editor, the preview and the
// export all agree on its size.

import { errorMessage } from "@main/services/errors";

/** The longest side an SVG is given, matching the crop editor's largest export. */
export const SVG_LONG_SIDE = 1024;

/** True for a source that is an SVG, by data URL or by file extension. */
export function isSvgSource(src: string): boolean {
  return src.startsWith("data:image/svg+xml") || /\.svg(?:[?#]|$)/i.test(src);
}

function numeric(v: string | null): number | null {
  if (!v) return null;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(?:px)?\s*$/.exec(v);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

/**
 * The same SVG with `width` and `height` set, longest side SVG_LONG_SIDE, in the
 * artwork's own aspect: from its width and height when both are plain numbers,
 * else from its viewBox, else 2:1 (the browser's default object size).
 * Throws when the text is not an SVG document.
 */
export function sizeSvgText(text: string): string {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.localName !== "svg" || doc.querySelector("parsererror")) throw new Error("not a valid SVG document");

  let w = numeric(root.getAttribute("width"));
  let h = numeric(root.getAttribute("height"));
  if (w === null || h === null) {
    const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
    const [vw, vh] = [vb[2], vb[3]];
    if (vb.length === 4 && vw && vh && vw > 0 && vh > 0) [w, h] = [vw, vh];
    else [w, h] = [300, 150];
  }
  const k = SVG_LONG_SIDE / Math.max(w, h);
  root.setAttribute("width", String(Math.round(w * k)));
  root.setAttribute("height", String(Math.round(h * k)));
  return new XMLSerializer().serializeToString(root);
}

/** A data URL for `svgText`. UTF-8 safe: btoa alone throws on anything above Latin-1. */
function toDataUrl(svgText: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

/**
 * The source to hand an image element: `src` itself unless it is an SVG, in which
 * case a sized copy. Rejects, with the reason, when the SVG cannot be read, so the
 * caller decides what to tell the operator.
 */
export async function drawableSource(src: string): Promise<string> {
  if (!isSvgSource(src)) return src;
  let text: string;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    throw new Error(`the SVG could not be read: ${errorMessage(err)}`, { cause: err });
  }
  return toDataUrl(sizeSvgText(text));
}
