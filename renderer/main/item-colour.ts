import type { PcoItemTypeColor } from "../../main/types/stage.js";

/** PCO stores #ffffff to mean "no colour" — it is the shipped default on Media. */
const UNSET = "#ffffff";

/**
 * The PCO item row colour for one item, or null when PCO says nothing about it.
 *
 * Custom types are checked first: they match text CONTAINED in the title, which the
 * operator typed deliberately, so they beat the broad standard-type match.
 */
export function resolveItemColour(
  item: { itemType: string; title: string },
  colours: PcoItemTypeColor[] | undefined,
): string | null {
  if (!colours || colours.length === 0) return null;
  const title = item.title.toLowerCase();
  const type = item.itemType.trim().toLowerCase();

  for (const c of colours) {
    if (!c.custom) continue;
    const needle = c.name.trim().toLowerCase();
    // "" is contained in every string — a blank entry must not paint the whole plan.
    if (!needle) continue;
    if (title.includes(needle)) return c.color === UNSET ? null : c.color;
  }

  for (const c of colours) {
    if (c.custom) continue;
    if (c.name.trim().toLowerCase() === type) return c.color === UNSET ? null : c.color;
  }

  return null;
}

/**
 * A row wash for a PCO colour, on a dark surface.
 *
 * PCO's palette is authored against a white table — its greens and blues are pale
 * pastels (Song is #e8f6df). Mixing one of those into a near-black background at a low
 * percentage keeps its LIGHTNESS but loses its hue: #e8f6df at 10% over #0a0a0a
 * measures rgb(33,34,32), which is neutral grey, not green.
 *
 * So the hue is kept and the saturation/lightness replaced with values that actually
 * read as a colour on a dark panel.
 */
export function washFor(hex: string): string {
  const h = hueOf(hex);
  if (h == null) return "rgba(255, 255, 255, 0.05)"; // greys have no hue to keep
  return `hsl(${Math.round(h)} 42% 15%)`;
}

/**
 * The row's left stripe, on a dark surface.
 *
 * The literal PCO colour does not work here either, for the same reason as the wash.
 * #e0f7ff is 88% lightness: at full strength on a near-black panel it reads as WHITE,
 * not as blue. The hue is present but there is almost no colour in it.
 *
 * So the stripe keeps the hue and takes a saturation and lightness that stay bright
 * enough to read at a distance while actually looking like a colour.
 */
export function stripeFor(hex: string): string {
  const h = hueOf(hex);
  if (h == null) return "rgba(255, 255, 255, 0.45)"; // greys stay a neutral rule
  return `hsl(${Math.round(h)} 72% 62%)`;
}

/** Hue in degrees, or null when the colour is effectively neutral. */
function hueOf(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  // A near-grey (PCO's Header #eaebeb) has no hue worth keeping.
  if (d < 0.04) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}
