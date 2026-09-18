// measure-text.ts — how wide is this string, in the lane's font?
//
// A canvas 2d context, because it is the only way to ask the browser about text
// it has not drawn yet. The alternative — render the label, read offsetWidth,
// decide, re-render — measures a frame late and flickers the wrong label once.
//
// The estimate below is NOT a test convenience. A browser with canvas disabled,
// and jsdom (which has no 2d context at all unless the optional `canvas` package
// is installed, and it is not a dependency here), both land on it. It is
// deliberately generous — 0.58em per character against IBM Plex Sans's ~0.52em
// average — so the failure mode is "showed the number when the title would just
// have fitted" rather than a clipped title.

import type { MeasureText } from "./lane";

const ESTIMATE_PER_CHAR = 0.58;

/** One measurer per font string, for the whole page. Two charts on screen and a
 *  re-render each is four canvases otherwise, and each one is a DOM element plus
 *  a graphics context the browser has to back. */
const cache = new Map<string, MeasureText>();

/**
 * A measurer for `font` (any CSS `font` shorthand), cached per font string.
 *
 * The canvas is created once and reused: one per font, not one per measurement,
 * because a chart with forty items measures forty strings per resize.
 */
export function makeTextMeasurer(font: string): MeasureText {
  const hit = cache.get(font);
  if (hit) return hit;
  const made = buildMeasurer(font);
  cache.set(font, made);
  return made;
}

function buildMeasurer(font: string): MeasureText {
  const ctx = canvasContext();
  if (!ctx) {
    const size = fontSizePx(font);
    return (text: string) => text.length * size * ESTIMATE_PER_CHAR;
  }
  ctx.font = font;
  return (text: string) => ctx.measureText(text).width;
}

/** px from a CSS `font` shorthand ("500 11px …"), defaulting to 11. */
function fontSizePx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 11;
}

function canvasContext(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  try {
    return document.createElement("canvas").getContext("2d");
  } catch {
    // A browser that refuses a context (canvas disabled, or a hardened kiosk
    // profile) is not a failure worth surfacing — the estimate is a correct,
    // slightly conservative answer. Nothing is lost and nothing is silent: the
    // lane still labels, just with the number more often.
    return null;
  }
}
