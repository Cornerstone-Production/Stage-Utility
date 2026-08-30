import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query. Used for *structural* responsive decisions
 * (e.g. render a drawer vs. an inline sidebar) where a Tailwind class alone can't
 * change behavior. For pure styling, prefer Tailwind `max-sm:` / `sm:` classes.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * The one width at which this app stops being a desktop app and starts being a
 * phone app: Tailwind's `sm`. Below it the sidebar becomes a drawer, the page
 * header goes, the gutter narrows — and the context bar reads its own item set.
 *
 * A NUMBER, exported, because more than one thing now needs it and only one of
 * them is CSS. The bar's configurator has to label which set it is editing and
 * size its preview to a phone, and the bar itself has to pick a set in JS; a
 * second literal in either place is two answers to "am I on a phone" that drift
 * apart, and the band between them is a bar configured for a viewport that
 * thinks it is the other one.
 *
 * 640 is not a rounder number than the alternative, it is the SAME number the
 * shell already turns on. It is also comfortably above the measured floor: the
 * widest set the bar can hold reaches its full, untruncated length well under
 * this, so no desktop bar is ever asked to give up a word above it. See
 * docs/features/context-bar.md for the measured table.
 */
export const MOBILE_MAX_WIDTH = 640;

/** True on phone-width viewports (below Tailwind's `sm` breakpoint of 640px). */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_MAX_WIDTH - 1}px)`);
}
