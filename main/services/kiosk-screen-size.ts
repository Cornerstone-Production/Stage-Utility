// Reading and phrasing a screen's size.
//
// Two sources say what a screen is, and they can disagree:
//
//   • the BROWSER — `screen.width`/`screen.height` in CSS pixels, available on
//     every platform, and what the display is actually laid out in;
//   • the PHYSICAL MODE — read from /sys/class/drm by the Linux agent and put on
//     the discovery probe. Linux only.
//
// A disagreement is the useful part: it means the desktop is scaled, which is
// the usual reason a Pi's 1920 x 1080 panel renders a 1280 x 720 layout. So both
// are kept and both are shown.
//
// Because they arrive separately and in either order, EVERY write of a screen
// size is a merge, never a replace. That rule lives here, in `mergeScreen`, and
// nowhere else — it was hand-rolled at four call sites first and the four had
// already drifted apart three different ways.

import type { ScreenSize } from "../types/kiosk.js";

/**
 * A browser-reported size from three unknowns, or null.
 *
 * Everything that reaches this comes off the LAN over plain HTTP — a query
 * string on the holding screen, a JSON body on the heartbeat — so both paths go
 * through here rather than each re-deciding what a plausible number is.
 */
export function screenFrom(w: unknown, h: unknown, dpr: unknown): ScreenSize | null {
  const nw = Number(w);
  const nh = Number(h);
  const ndpr = Number(dpr);
  // An 8K screen is 7680 wide. The cap is not about the display, it is about
  // refusing a number that would render as junk on the card.
  if (!Number.isFinite(nw) || !Number.isFinite(nh) || nw < 1 || nh < 1 || nw > 32_000 || nh > 32_000) {
    return null;
  }
  return {
    w: Math.round(nw),
    h: Math.round(nh),
    dpr: Number.isFinite(ndpr) && ndpr > 0 && ndpr <= 8 ? ndpr : undefined,
  };
}

/** Parse `?w=&h=&dpr=` off a URL. */
export function screenFromQuery(params: URLSearchParams): ScreenSize | null {
  return screenFrom(params.get("w"), params.get("h"), params.get("dpr"));
}

/**
 * Fold what just arrived into what was already known.
 *
 * Each source is authoritative only over its own half — the browser over w/h/dpr,
 * the probe over the mode — so an absent field means "I have nothing to say
 * about this", never "clear it". Note that an EXPLICIT `dpr: undefined` is
 * absent by this rule: `screenFrom` always emits the key, so a plain object
 * spread would let a device with no dpr wipe one already recorded.
 */
export function mergeScreen(
  prev: ScreenSize | undefined,
  next: Partial<ScreenSize> | undefined,
): ScreenSize | undefined {
  if (!prev && !next) return undefined;
  // Zero counts as absent, not as a value. The probe carries a mode with no
  // browser size and fills w/h with 0 to satisfy the type; `screenFrom` never
  // returns a dimension below 1, so no real report is lost to this.
  const w = next?.w || prev?.w || 0;
  const h = next?.h || prev?.h || 0;
  const dpr = next?.dpr ?? prev?.dpr;
  const mode = next?.mode ?? prev?.mode;
  // Keys are omitted rather than set to undefined, so a merged size compares
  // equal to a freshly built one and round-trips through JSON unchanged.
  return { w, h, ...(dpr === undefined ? {} : { dpr }), ...(mode === undefined ? {} : { mode }) };
}

/** Whether two sizes would read identically — the test for "is this worth a
 *  write, or a broadcast". */
export function sameScreen(a: ScreenSize | undefined, b: ScreenSize | undefined): boolean {
  return a?.w === b?.w && a?.h === b?.h && a?.dpr === b?.dpr && a?.mode === b?.mode;
}

/** "1920 × 1080", and the mode too when it disagrees. Empty when nothing is
 *  known, so the caller can drop the field entirely. */
export function describeScreen(s: ScreenSize | undefined): string {
  if (!s) return "";
  const css = s.w > 0 && s.h > 0 ? `${s.w} × ${s.h}` : "";
  const mode = s.mode?.replace("x", " × ");
  if (css && mode && mode !== css) return `${css} (driving ${mode})`;
  return css || (mode ? `driving ${mode}` : "");
}
