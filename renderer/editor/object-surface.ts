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

import type { LayoutSurface } from "@main/types/views";
import { CARD_PRESETS } from "../main/layout-objects";

export type SurfaceKind = LayoutSurface;
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
  flat: { surface: "flat", background: null, borderColor: null, borderWidth: 0, boxShadow: 0 },
  // GLASS STAYS TRANSLUCENT. It is the one look whose whole point is that the
  // canvas shows through, so making it opaque would leave no way to ask for
  // that at all. Everything else went opaque because nothing else was asking.
  glass: { surface: "glass", background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 0.001, cornerRadius: 0.0148, boxShadow: 0 },
  solid: { surface: "solid", background: "var(--gray-2)", borderColor: null, borderWidth: 0, cornerRadius: 0.0148, boxShadow: 0.35 },
  outline: { surface: "outline", background: null, borderColor: "rgba(255,255,255,0.35)", borderWidth: 0.0015, cornerRadius: 0.0148, boxShadow: 0 },
};

export const SURFACES: { value: SurfaceKind; label: string; hint: string }[] = [
  // "None", not "Flat". Asked what the difference between Flat and Solid was,
  // the honest answer is that one of them is not a material at all — Flat draws
  // NOTHING, and the widget sits straight on the screen behind it. Named for
  // what it does, the question does not arise.
  { value: "flat", label: "None", hint: "No card at all — the widget sits straight on the screen" },
  { value: "glass", label: "Glass", hint: "A translucent card — the screen behind shows through" },
  { value: "solid", label: "Solid", hint: "An opaque card, with a shadow under it" },
  { value: "outline", label: "Outline", hint: "A hairline border and nothing behind it" },
];

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

/**
 * Which surface this style is wearing. Always one of the four.
 *
 * The stored choice wins outright, which is the whole point: tint it, round its
 * corners, pick a colour of your own — it is still the material you asked for,
 * and the dropdown goes on saying so.
 *
 * Anything made before the choice was recorded is CLASSIFIED from what it
 * actually draws. That is a total function on purpose: "Custom" was never an
 * entry in the list, so it has no business being what the list reads.
 */
export function surfaceOf(s: LayoutStyle): SurfaceKind {
  if (s.surface && SURFACE_PRESETS[s.surface]) return s.surface;
  const bg = s.background ?? null;
  if (bg) {
    // Translucent grounds are glass; opaque ones are a card. An rgba/hsla with
    // an alpha below 1 is the only thing that can show the screen through it.
    const alpha = /^(?:rgba|hsla)\([^)]*,\s*([\d.]+)\s*\)$/i.exec(bg)?.[1];
    return alpha !== undefined && Number(alpha) < 1 ? "glass" : "solid";
  }
  if (s.borderColor && (s.borderWidth ?? 0) > 0) return "outline";
  return "flat";
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
  // A hand-picked colour is kept as it is: it was chosen deliberately, and
  // re-resolving it as if it were a tint would throw it away on a click that
  // only meant to change the material.
  const background = isCustomFill(current) ? current.background ?? null : tintedBackground(surface, tint);
  return { ...SURFACE_PRESETS[surface], background };
}

/** The patch for choosing a tint, at the strength this surface calls for. */
export function applyTint(current: LayoutStyle, tint: TintKind): LayoutStyle {
  return { background: tintedBackground(surfaceOf(current), tint) };
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
  return bg !== (SURFACE_PRESETS[surfaceOf(s)].background ?? null);
}
