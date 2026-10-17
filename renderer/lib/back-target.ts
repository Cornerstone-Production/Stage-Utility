// Where a page's back arrow goes: the page you came from.
//
// A page reachable from both a chromeless launcher and one inside the shell (a
// ServiceCue rundown) cannot hard-code its way back; whichever target it names
// is wrong for one door in. The launcher stamps its own path on the links it
// draws as `?from=<path>`, and the arrow returns there. The address carries it,
// not router state, because those links are plain anchors (document loads) and
// state cannot cross one; an address also survives a reload, and a page that
// changes its own params keeps it through `keepSearch`. With no valid `from`
// (a typed URL, a QR code, a kiosk), or one the page does not list as a way in,
// the arrow goes to the page's own fallback.
// An address copied from the bar carries its `from` along.

import { useCallback } from "react";

import { useRouterHandle, useSearchParam } from "./use-search-param";

/** The search param naming the page you came from. */
const ORIGIN_PARAM = "from";

/**
 * For a page that links INTO one with a back arrow: returns a function that
 * stamps the link with this page's own path, so the arrow can lead back here.
 */
export function useOriginHref(): (href: string) => string {
  const router = useRouterHandle();
  return useCallback(
    (href) => {
      const origin = router ? router.state.location.pathname : window.location.pathname;
      return `${href}${href.includes("?") ? "&" : "?"}${ORIGIN_PARAM}=${encodeURIComponent(origin)}`;
    },
    [router],
  );
}

/**
 * For a page with a back arrow: the page you came from, or `fallback` when the
 * address names none, or names a page that is not one of `allowed`.
 *
 * The address is anyone's to write and the result becomes an `href`, so it is
 * never used as given: it only selects one of the caller's own paths, and the
 * href is that constant.
 */
export function useBackHref(fallback: string, allowed: readonly string[]): string {
  const [from] = useSearchParam(ORIGIN_PARAM);
  return allowed.find((path) => path === from) ?? fallback;
}
