// score-ink.ts — readable text over a team's own colour.
//
// ESPN's colours are brand colours picked for contrast against ESPN's chrome,
// not ours. A near-white alternateColor ("ffffff" was observed on an NFL team)
// with white text on it is unreadable, so the ink is CHOSEN per colour by
// relative luminance rather than fixed.
//
// WCAG 2.1 relative luminance and contrast ratio, which is the only definition
// of "readable" that is not a guess.
//
// THE MATH IS NOT WRITTEN HERE. parseColor, relativeLuminance and contrastRatio
// all live in components/ui/color-math.ts, and a second copy of the WCAG formula
// is a second copy that can drift — this one already had. Its luminance returned
// 0 for a string it could not read, which makes an unparseable colour look like
// black, and therefore like a colour with plenty of contrast against a light
// disc: discInk("nope") returned "nope". That reaches the DOM as
// `--score-disc-ink: nope`, invalid at computed-value time, so `.score-logo`
// falls back to the inherited `--score-ink: white` and a dark-brand team's
// abbreviation is invisible on the #f2f2f2 disc — the one outcome discInk exists
// to prevent. color-math answers 1 for anything it cannot parse, the "cannot be
// read" end, which is the answer a floor should get.
//
// What IS written here is the boundary. ESPN sends a bare six-digit hex with no
// leading "#" and parseColor requires one. scores-parse.ts normalises on the way
// in, but this module's stated contract is that ESPN can send anything, so it
// normalises again rather than resting on a caller two files away.

import { contrastRatio, parseColor, relativeLuminance } from "../components/ui/color-math";

/** ESPN's bare "0e3386" as the "#0e3386" parseColor requires. */
function withHash(hex: string): string {
  return hex.startsWith("#") ? hex : `#${hex}`;
}

/** sRGB relative luminance, or 0 for a colour that cannot be read. */
export function luminance(hex: string): number {
  const c = parseColor(withHash(hex));
  return c ? relativeLuminance(c) : 0;
}

/** WCAG contrast ratio, 1..21 — 1 for anything unreadable, so a colour that
 *  will not parse FAILS every floor rather than clearing all of them. */
export function contrastOf(a: string, b: string): number {
  return contrastRatio(withHash(a), withHash(b));
}

/** Near-black rather than pure black: pure black on a mid brand colour reads as
 *  a hole, and the app's own dark ink is this value. */
export const INK_DARK = "#0a0a0a";
export const INK_LIGHT = "#ffffff";

/** Whichever of the two inks contrasts better against this team's colour. */
export function inkFor(hex: string | null): string {
  if (!hex || !parseColor(withHash(hex))) return INK_LIGHT;
  return contrastOf(hex, INK_LIGHT) >= contrastOf(hex, INK_DARK) ? INK_LIGHT : INK_DARK;
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
  // The parse guard is EXPLICIT rather than left to the ratio, because what this
  // returns is handed straight to CSS. A string this module could not read
  // becomes an invalid custom-property value, and the declaration behind it is
  // the white ink — so an unreadable colour produced exactly the invisible mark
  // this function exists to prevent.
  if (!color || !parseColor(withHash(color))) return INK_DARK;
  // withHash on the way OUT as well. ESPN's own form, "0e3386", is not a CSS
  // colour, so handing the input back verbatim was the same invalid-value
  // failure by a shorter route.
  return contrastOf(color, DISC) >= 4.5 ? withHash(color) : INK_DARK;
}
