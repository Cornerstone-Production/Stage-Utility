// score-ink.ts — readable text over a team's own colour.
//
// ESPN's colours are brand colours picked for contrast against ESPN's chrome,
// not ours. A near-white alternateColor ("ffffff" was observed on an NFL team)
// with white text on it is unreadable, so the ink is CHOSEN per colour by
// relative luminance rather than fixed.
//
// WCAG 2.1 relative luminance and contrast ratio, which is the only definition
// of "readable" that is not a guess.

/** sRGB relative luminance, WCAG 2.1 §relative-luminance. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Near-black rather than pure black: pure black on a mid brand colour reads as
 *  a hole, and the app's own dark ink is this value. */
export const INK_DARK = "#0a0a0a";
export const INK_LIGHT = "#ffffff";

/** Whichever of the two inks contrasts better against this team's colour. */
export function inkFor(hex: string | null): string {
  if (!hex) return INK_LIGHT;
  return contrastRatio(hex, INK_LIGHT) >= contrastRatio(hex, INK_DARK) ? INK_LIGHT : INK_DARK;
}

/** The ink at reduced strength, for a logo chip's fill behind the team colour. */
export function inkSoft(ink: string): string {
  return ink === INK_LIGHT ? "rgba(255,255,255,.93)" : "rgba(10,10,10,.9)";
}
