// Where a page's back arrow goes: the page you came from.
//
// A page reachable from both a chromeless launcher and one inside the shell (a
// ServiceCue rundown) cannot hard-code its way back; whichever target it names
// is wrong for one door in. The launcher stamps its own path on the links it
// draws as `?from=<path>`, and the arrow returns there. The address carries it,
// not router state, because those links are plain anchors (document loads) and
// state cannot cross one; an address also survives a reload, and a page that
// changes its own params keeps it through `keepSearch`. With no valid `from`
// (a typed URL, a QR code, a kiosk) the arrow goes to the page's own fallback.
// An address copied from the bar carries its `from` along.

import { useCallback } from "react";

import { useRouterHandle, useSearchParam } from "./use-search-param";

/** The search param naming the page you came from. */
const ORIGIN_PARAM = "from";

/**
 * `raw` if it is a path inside this app, otherwise null.
 *
 * The value arrives from an address anyone can write, and ends up as an
 * `href`, so it is held to a bare absolute path: no scheme, no `//host`, no
 * backslash (browsers read `/\host` as `//host`), no query and no hash.
 */
function parseOrigin(raw: string | null): string | null {
  if (raw === null) return null;
  return /^\/(?![/\\])[^\s?#\\]*$/.test(raw) ? raw : null;
}

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
 * address names none (or names something that is not a path in this app).
 */
export function useBackHref(fallback: string): string {
  const [from] = useSearchParam(ORIGIN_PARAM);
  return parseOrigin(from) ?? fallback;
}
