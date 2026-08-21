// object-surface.ts — the two independent questions the Look section asks.
//
// SURFACE is the material: Flat, Glass, Solid, Outline. TINT is the colour it
// is washed with. They are orthogonal on purpose — the list that mixed them
// (Glass, Glass·Green, Glass·Red, …) was longer and still could not express a
// red Solid.
//
// Keeping them orthogonal takes more than two lists, because both want to write
// the SAME field. A style is a flat patch, so `background` is the only place
// either can live, and the naive version — surface writes a background, tint
// overwrites it — meant every tinted object stopped matching its own surface
// and the dropdown read "Custom" for a look you had just picked from it.
//
// So the surface is identified by its STRUCTURE (border, radius, shadow) plus a
// background it is allowed to be wearing, and the tint owns the background
// within that allowance. Both then always name themselves.
//
// The other half of the same bug: a tint over Glass was an OPAQUE near-black,
// which is not tinted glass — it is a card with a glass hairline round it, and
// the canvas no longer showed through at all. A tint is now resolved AGAINST
// the surface: translucent over Glass, opaque everywhere else.

import { CARD_PRESETS } from "../main/layout-objects";

export type SurfaceKind = "flat" | "glass" | "solid" | "outline";
export type TintKind = "none" | "neutral" | "green" | "red" | "amber";

/**
 * The four surfaces.
 *
 * Elevated is gone: it was a fifth entry that differed from Solid by a shadow,
 * and the dropdown was already too long to read. Removing it changes no saved
 * layout — these are style patches, not a stored enum — and LEGACY_ELEVATED
 * below keeps an object already wearing it naming itself.
 */
export const SURFACE_PRESETS: Record<SurfaceKind, LayoutStyle> = {
  flat: { background: null, borderColor: null, borderWidth: 0, boxShadow: 0 },
  // GLASS STAYS TRANSLUCENT. It is the one look whose whole point is that the
  // canvas shows through, so making it opaque would leave no way to ask for
  // that at all. Everything else went opaque because nothing else was asking.
  glass: { background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 0.001, cornerRadius: 0.0148, boxShadow: 0 },
  solid: { background: "var(--gray-2)", borderColor: null, borderWidth: 0, cornerRadius: 0.0148, boxShadow: 0.35 },
  outline: { background: null, borderColor: "rgba(255,255,255,0.35)", borderWidth: 0.0015, cornerRadius: 0.0148, boxShadow: 0 },
};

export const SURFACES: { value: SurfaceKind; label: string }[] = [
  { value: "flat", label: "Flat" },
  { value: "glass", label: "Glass" },
  { value: "solid", label: "Solid" },
  { value: "outline", label: "Outline" },
];

/** What Elevated used to be, kept ONLY so an object already wearing it still
 *  matches a named surface instead of reading as "custom". Never offered. */
const LEGACY_ELEVATED: LayoutStyle = {
  background: "#191919", borderColor: "rgba(255,255,255,0.10)", borderWidth: 0.001, cornerRadius: 0.0148, boxShadow: 0.6,
};

/**
 * The tints.
 *
 * `opaque` is the wash for a material that is its own colour — the near-blacks
 * the card presets already use, made for a stage canvas that is itself
 * near-black. `sheer` is the same hue at glass strength, so tinted glass is
 * still glass: the canvas shows through it.
 *
 * `swatch` is what the button shows. It is the opaque value even for glass,
 * because a 7%-alpha circle on a dark panel is not a colour anyone can pick
 * from — the swatch names the hue, the surface decides the strength.
 */
export const TINTS: { value: TintKind; label: string; swatch: string | null; opaque: string | null; sheer: string | null }[] = [
  { value: "none", label: "No tint", swatch: null, opaque: null, sheer: null },
  // Black over glass DARKENS it. The obvious-looking "more white" would have
  // been the exact string glass already uses, making an untinted glass read as
  // tinted Black — and the tint could then never be cleared.
  { value: "neutral", label: "Black", swatch: "#141414", opaque: CARD_PRESETS.neutral.background ?? null, sheer: "rgba(0,0,0,0.35)" },
  { value: "green", label: "Green", swatch: "#0d1a15", opaque: CARD_PRESETS.green.background ?? null, sheer: "rgba(45,212,150,0.10)" },
  { value: "red", label: "Red", swatch: "#201011", opaque: CARD_PRESETS.red.background ?? null, sheer: "rgba(229,72,77,0.12)" },
  { value: "amber", label: "Amber", swatch: "#1e190e", opaque: CARD_PRESETS.amber.background ?? null, sheer: "rgba(255,197,61,0.10)" },
];

/**
 * The background a given tint means on a given surface.
 *
 * "No tint" is not "no background": on Glass it is the glass itself, on Solid
 * the solid's own fill. Clearing the background there would leave the object
 * transparent while the dropdown still said Glass.
 */
export function tintedBackground(surface: SurfaceKind | "", tint: TintKind): string | null {
  const preset = surface ? SURFACE_PRESETS[surface] : null;
  if (tint === "none") return preset?.background ?? null;
  const t = TINTS.find((x) => x.value === tint);
  if (!t) return preset?.background ?? null;
  return surface === "glass" ? t.sheer : t.opaque;
}

/** Every background that counts as "this surface, wearing some tint". */
function allowedBackgrounds(surface: SurfaceKind, preset: LayoutStyle): (string | null)[] {
  return [
    preset.background ?? null,
    ...TINTS.filter((t) => t.value !== "none").flatMap((t) =>
      // BOTH strengths, whichever surface this is. An object tinted before the
      // sheer values existed carries the opaque one, and refusing to recognise
      // it would leave exactly the "Custom" this file exists to stop. Clicking
      // any tint re-resolves it to the right strength for its surface.
      [surface === "glass" ? t.sheer : t.opaque, surface === "glass" ? t.opaque : t.sheer],
    ),
  ];
}

/**
 * Which surface this style is wearing, or "" for a hand-tuned one.
 *
 * Structure decides it. `background` is compared only against what the surface
 * is ALLOWED to be wearing — its own, or any tint — because the tint owns that
 * field. A background outside the allowance is genuinely custom: somebody
 * picked a colour, and saying "Glass" over it would be a lie.
 */
/**
 * Compare one structural field.
 *
 * A style is a PATCH, so "no shadow" is written both as `boxShadow: 0` and as
 * no key at all, and treating those as different is why the app's own default
 * card — the look most objects ship wearing — reported itself as "Custom" in a
 * dropdown that had never been touched.
 */
function sameField(a: unknown, b: unknown, key: keyof LayoutStyle): boolean {
  const NUMERIC = ["borderWidth", "boxShadow", "cornerRadius"];
  if (NUMERIC.includes(key as string)) return (a ?? 0) === (b ?? 0);
  return (a ?? null) === (b ?? null);
}

export function matchSurface(s: LayoutStyle): SurfaceKind | "" {
  const named: [SurfaceKind, LayoutStyle][] = [
    ...SURFACES.map((x) => [x.value, SURFACE_PRESETS[x.value]] as [SurfaceKind, LayoutStyle]),
    ["solid", LEGACY_ELEVATED],
  ];
  for (const [value, style] of named) {
    const structural = (Object.keys(style) as (keyof LayoutStyle)[]).filter((k) => k !== "background");
    if (!structural.every((k) => sameField(s[k], style[k], k))) continue;
    if (!allowedBackgrounds(value, style).includes(s.background ?? null)) continue;
    return value;
  }
  return "";
}

/**
 * Which tint, matched on the background alone — the surface owns the rest, so a
 * tint over Outline leaves the border exactly where the surface put it.
 *
 * Both strengths match, for the same reason `allowedBackgrounds` accepts both.
 */
export function matchTint(s: LayoutStyle): TintKind {
  const bg = s.background ?? null;
  for (const t of TINTS) {
    if (t.value === "none") continue;
    if (bg === t.opaque || bg === t.sheer) return t.value;
  }
  return "none";
}

/**
 * The patch for choosing a surface, keeping whatever tint was already on.
 *
 * Re-resolved rather than carried across verbatim: moving a green Solid to
 * Glass has to become the sheer green, or the "glass" you asked for would be an
 * opaque green card.
 */
export function applySurface(current: LayoutStyle, surface: SurfaceKind): LayoutStyle {
  const tint = matchTint(current);
  return { ...SURFACE_PRESETS[surface], background: tintedBackground(surface, tint) };
}

/** The patch for choosing a tint, at the strength this surface calls for. */
export function applyTint(current: LayoutStyle, tint: TintKind): LayoutStyle {
  return { background: tintedBackground(matchSurface(current), tint) };
}

/**
 * Is the fill a colour somebody picked, rather than one of the swatches?
 *
 * Not the same question as `matchTint(s) === "none"`. A hand-picked red matches
 * no tint, but it is not "no tint" either — treating the two as one lit the
 * No-tint slash while the object was plainly red.
 */
export function isCustomFill(s: LayoutStyle): boolean {
  if (matchTint(s) !== "none") return false;
  const bg = s.background ?? null;
  if (bg === null) return false;
  const surface = matchSurface(s);
  return bg !== (surface ? SURFACE_PRESETS[surface].background ?? null : null);
}
