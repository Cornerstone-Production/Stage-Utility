// Colour conversions for the app's own picker.
//
// The native `<input type="color">` was the app's colour control everywhere. It
// is an OS panel: it does not take the app's theme, it cannot express an alpha
// (so a translucent glass tint had to be typed as a string somewhere else), and
// on a touch screen at the back of a room it is a system window over a live
// dashboard. This is the maths behind replacing it.
//
// Everything here is pure and total: a colour control that throws on a half-typed
// hex is worse than one that does nothing, so every parse has an answer.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1. Anything below 1 is what the native input could never express. */
  a: number;
}

export interface Hsva {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
  /** 0..1 */
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const byte = (n: number) => clamp(Math.round(n), 0, 255);
const hex2 = (n: number) => byte(n).toString(16).padStart(2, "0");

/**
 * Any CSS colour this app stores, as numbers.
 *
 * Handles what the styles actually contain — #rgb, #rrggbb, #rrggbbaa, rgb(),
 * rgba() — and nothing else. A named colour or a var() reference is NOT parsed:
 * they cannot be resolved without a document, and guessing would show the
 * operator a colour that is not the one on screen. Those return null, and the
 * caller decides what to show instead.
 */
export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const v = input.trim();

  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (m3) return { r: parseInt(m3[1] + m3[1], 16), g: parseInt(m3[2] + m3[2], 16), b: parseInt(m3[3] + m3[3], 16), a: 1 };

  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(v);
  if (m6) {
    return {
      r: parseInt(m6[1], 16),
      g: parseInt(m6[2], 16),
      b: parseInt(m6[3], 16),
      a: m6[4] === undefined ? 1 : parseInt(m6[4], 16) / 255,
    };
  }

  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(v);
  if (fn) {
    const rawA = fn[4];
    const a = rawA === undefined ? 1 : rawA.endsWith("%") ? Number(rawA.slice(0, -1)) / 100 : Number(rawA);
    return {
      r: byte(Number(fn[1])),
      g: byte(Number(fn[2])),
      b: byte(Number(fn[3])),
      a: Number.isFinite(a) ? clamp(a, 0, 1) : 1,
    };
  }
  return null;
}

/**
 * Back to a CSS string.
 *
 * Hex while it is opaque, rgba() once it is not — hex is what the rest of the
 * app's styles are written in, and an #rrggbbaa is not understood by every
 * consumer that reads these strings back.
 */
export function formatColor({ r, g, b, a }: Rgba): string {
  if (a >= 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  const rounded = Math.round(clamp(a, 0, 1) * 100) / 100;
  return `rgba(${byte(r)},${byte(g)},${byte(b)},${rounded})`;
}

export function rgbaToHsva({ r, g, b, a }: Rgba): Hsva {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a };
}

export function hsvaToRgba({ h, s, v, a }: Hsva): Rgba {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  const [r1, g1, b1] =
    hh < 60 ? [c, x, 0]
    : hh < 120 ? [x, c, 0]
    : hh < 180 ? [0, c, x]
    : hh < 240 ? [0, x, c]
    : hh < 300 ? [x, 0, c]
    : [c, 0, x];
  return { r: byte((r1 + m) * 255), g: byte((g1 + m) * 255), b: byte((b1 + m) * 255), a: clamp(a, 0, 1) };
}

/**
 * What the operator typed, if it is a colour yet.
 *
 * Tolerant on the way in — a missing "#" is the most common way to type a hex —
 * and null while it is still half-typed, so the field does not lurch through
 * three wrong colours as somebody types six characters.
 */
export function parseTypedColor(text: string): Rgba | null {
  const t = text.trim();
  if (!t) return null;
  const withHash = /^[0-9a-f]{3,8}$/i.test(t) ? `#${t}` : t;
  return parseColor(withHash);
}

/**
 * Is this colour dark enough that white sits on it better than black?
 *
 * Relative luminance, weighted the way the eye is. Used for the checkmark on a
 * chosen swatch: a fixed colour there disappears on half the palette.
 */
export function isDark({ r, g, b }: Rgba): boolean {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.55;
}
