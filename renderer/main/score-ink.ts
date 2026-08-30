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

/**
 * The disc every team mark sits on. FIXED, and light for every team.
 *
 * ESPN's logos are PNGs in the club's own colours, and a great many of them are
 * navy, black or dark green — the Yankees and the Packers were the pair that
 * made the point — so on this app's dark cards the mark simply is not there.
 *
 * It is light rather than dark because that is the background ESPN drew these
 * for: the CDN publishes `.../500/nyy.png` for light grounds and a separate
 * `.../500-dark/nyy.png` for dark ones, and `logos[0]` — the one cached at
 * selection time — is the light-ground version.
 *
 * UNIFORM, not per team. It used to be the inverse of the ink chosen for the
 * team's colour, which made two clubs in one strip carry opposite discs, and it
 * still left a dark mark on a dark disc whenever a club's brand colour was light
 * but its logo was not. Choosing per image would need the image's own pixels,
 * which nothing here has.
 *
 * Kept just off white: pure white against the near-black card is a harder edge
 * than the mark inside it, and the disc is meant to be the ground, not the
 * subject.
 */
export const DISC = "#f2f2f2";

/**
 * The team's abbreviation on that disc, for a team with no logo — 83 of college
 * football's teams, and any team whose CDN this church's network will not reach.
 *
 * The brand colour when it is legible on the disc, and the dark ink when it is
 * not. A team colour is chosen against ESPN's chrome, not ours: roughly one club
 * in ten is light enough that its own colour on a light disc is unreadable, and
 * an identifier you cannot read is worse than one that is not on-brand.
 */
export function discInk(color: string | null): string {
  if (!color) return INK_DARK;
  return contrastRatio(color, DISC) >= 4.5 ? color : INK_DARK;
}
