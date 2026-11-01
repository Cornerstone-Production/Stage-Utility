// Which ink an icon's art is drawn in, so it can be read against what is behind it.
//
// "Recolor to match theme" turns a single-colour logo into the theme's own ink:
// dark on a light surface, light on a dark one. The tab strip and the editor have a
// theme to follow. An icon with a background of its own does not: a white logo on a
// white home-screen icon has to turn dark, so the ink is chosen from the background.

/** The app's own `--su-fg` in `:root` and `.dark` (renderer/styles.css). Named by
 *  the theme it is the ink OF, so `light` is the dark colour a light theme draws in. */
export const INK = { light: "#161b22", dark: "#ededf0" } as const;

/** The same two inks named by their colour, which is what a background is matched against. */
export const DARK_INK = INK.light;
export const LIGHT_INK = INK.dark;

/** The WCAG relative luminance of a `#rrggbb` colour: 0 is black, 1 is white. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** The WCAG contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of the app's two inks reads better on `background`. */
export function inkOn(background: string): string {
  return contrastRatio(DARK_INK, background) >= contrastRatio(LIGHT_INK, background) ? DARK_INK : LIGHT_INK;
}

/**
 * The ink for art drawn over `background`, or null to draw it as uploaded.
 * With Recolor off the art is the operator's own colours, whatever is behind it.
 */
export function iconInk(background: string, recolor: boolean): string | null {
  return recolor ? inkOn(background) : null;
}

/** The accent when the page has none to read: the app's own default blue. */
const DEFAULT_ACCENT = "#2e6691";

/**
 * The accent as a `#rrggbb`: what the app is drawing in right now.
 *
 * `cssValue` is `--brand-accent` as the page resolves it (the picked accent, else
 * the theme's own default, which differs between light and dark). The icon's Accent
 * background is stored as this colour at the moment it is picked, not as a promise
 * to follow the theme: the home-screen images are PNGs the server keeps, so a
 * follow would go stale on every phone the moment the accent changed.
 */
export function resolveAccent(accentColor: string | null, cssValue: string): string {
  for (const candidate of [cssValue.trim(), accentColor ?? ""]) {
    if (/^#[0-9a-f]{6}$/i.test(candidate)) return candidate.toLowerCase();
  }
  return DEFAULT_ACCENT;
}

/**
 * The colour of a tab background as the state holds it, or null for none.
 *
 * The state says "none" for a tab with no background; anything that is not a
 * `#rrggbb` is read the same way, rather than drawn as a colour the canvas would
 * misparse. (The renderer reads it here and not from the server's constant: this
 * file is in the public viewer's bundle, and that bundle takes no server modules
 * beyond the few it already shares.)
 */
export function tabColor(stored: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(stored) ? stored.toLowerCase() : null;
}
