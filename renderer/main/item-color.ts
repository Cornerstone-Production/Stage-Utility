import type { PcoItemTypeColor } from "../../main/types/stage.js";

/** PCO stores #ffffff to mean "no color" — it is the shipped default on Media. */
const UNSET = "#ffffff";

/**
 * The PCO item row color for one item, or null when PCO says nothing about it.
 *
 * Custom types are checked first: they match text CONTAINED in the title, which the
 * operator typed deliberately, so they beat the broad standard-type match.
 */
export function resolveItemColor(
  item: { itemType: string; title: string },
  colors: PcoItemTypeColor[] | undefined,
): string | null {
  if (!colors || colors.length === 0) return null;
  const title = item.title.toLowerCase();
  const type = item.itemType.trim().toLowerCase();

  for (const c of colors) {
    if (!c.custom) continue;
    const needle = c.name.trim().toLowerCase();
    // "" is contained in every string — a blank entry must not paint the whole plan.
    if (!needle) continue;
    if (title.includes(needle)) return c.color === UNSET ? null : c.color;
  }

  for (const c of colors) {
    if (c.custom) continue;
    if (c.name.trim().toLowerCase() === type) return c.color === UNSET ? null : c.color;
  }

  return null;
}

/**
 * PCO's swatch mapped to the color actually rendered.
 *
 * PCO's palette is pale pastels authored for a white table — used literally on a dark
 * panel they read as near-white (#e0f7ff is 88% lightness). Each hue BAND maps to a
 * color chosen for a dark surface.
 *
 * Keyed by band rather than exact hex because only four of PCO's seven swatch values
 * have ever come back from the API; a band covers the rest without guessing, and holds
 * if PCO adjusts a swatch.
 *
 * Blue and lavender are crossed on purpose: PCO's blue (hue ~197) takes the deeper
 * #4a86c8 and PCO's lavender (hue ~265) takes the brighter #58c1e4. Lavender also never
 * renders as purple, which the project rule forbids.
 */
const PALETTE: { from: number; to: number; color: string }[] = [
  { from: 75, to: 160, color: "#46a758" },   // green
  { from: 160, to: 250, color: "#4a86c8" },  // PCO blue
  { from: 250, to: 290, color: "#58c1e4" },  // PCO lavender
  { from: 290, to: 345, color: "#e0729a" },  // pink
];
/** 345-75 wraps through zero, so it is the fallthrough rather than a band. */
const WARM = "#ffb224";

/** The curated color for a PCO swatch, or null when PCO means "no color". */
export function mapPcoColor(hex: string): string | null {
  if (hex.trim().toLowerCase() === UNSET) return null;
  const h = hueOf(hex);
  if (h == null) return null; // near-gray (PCO's Header) — nothing to map
  for (const b of PALETTE) if (h >= b.from && h < b.to) return b.color;
  return WARM;
}

/**
 * The row's left stripe. Bright and saturated so it reads at a distance.
 */
export function stripeFor(color: string): string {
  const h = hueOf(color);
  if (h == null) return "rgba(255, 255, 255, 0.45)";
  return `hsl(${Math.round(h)} 72% 62%)`;
}

/**
 * The wash behind the row. Same hue, dark enough to sit under text — one value cannot
 * serve both a 3px rule and a text background.
 */
export function washFor(color: string): string {
  const h = hueOf(color);
  if (h == null) return "rgba(255, 255, 255, 0.05)";
  return `hsl(${Math.round(h)} 42% 15%)`;
}

/** Hue in degrees, or null when the color is effectively neutral. */
function hueOf(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  // A near-gray (PCO's Header #eaebeb) has no hue worth keeping.
  if (d < 0.04) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}
