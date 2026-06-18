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

/** True on phone-width viewports (below Tailwind's `sm` breakpoint of 640px). */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 639px)");
}
