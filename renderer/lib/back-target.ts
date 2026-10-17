// Where a page's back arrow goes: where you came from.
//
// A page that is chromeless but reachable from a page that is not (a ServiceCue
// rundown, opened from the operator's launcher in the shell or from the tablet's
// chromeless one) cannot hard-code its way back: whichever target it names is
// wrong for one of the two doors in. The page you came from is the only answer
// that is right for both.
//
// It is carried in the ADDRESS, as `?from=<path>`, and not in router history
// state or `document.referrer`:
//
//   - the links into these pages are plain anchors, i.e. document loads, and a
//     document load starts a history entry with no state — so state cannot cross
//     the very hop it is needed for;
//   - an address survives a reload, a copied link and a restored tab;
//   - `document.referrer` is empty under a strict Referrer-Policy and in a home
//     screen app, and says nothing about the page's own sub-navigation.
//
// A page reached with no `from` — a typed URL, a QR code, a kiosk — falls back
// to the target it always had. An address copied from the bar carries its `from`
// along, which is the cost of the address being the carrier. A page that changes its own
// params (layout, plan, text size) keeps `from` through `keepSearch`.

import { useCallback } from "react";

import { useRouterHandle, useSearchParam } from "./use-search-param";

/** The search param naming the page you came from. */
export const ORIGIN_PARAM = "from";

/**
 * `raw` if it is a path inside this app, otherwise null.
 *
 * The value arrives from an address anyone can write, and ends up as an
 * `href`, so it is held to a bare absolute path: no scheme, no `//host`, no
 * backslash (browsers read `/\host` as `//host`), no query and no hash.
 */
export function parseOrigin(raw: string | null): string | null {
  if (raw === null) return null;
  return /^\/(?![/\\])[^\s?#\\]*$/.test(raw) ? raw : null;
}

/** `href` with `origin` appended as the page-you-came-from param. */
export function withOrigin(href: string, origin: string): string {
  const path = origin.length > 1 && origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${href}${href.includes("?") ? "&" : "?"}${ORIGIN_PARAM}=${encodeURIComponent(path)}`;
}

/**
 * For a page that links INTO one with a back arrow: returns a function that
 * stamps the link with this page's own path, so the arrow can lead back here.
 */
export function useOriginHref(): (href: string) => string {
  const router = useRouterHandle();
  return useCallback(
    (href) => withOrigin(href, router ? router.state.location.pathname : window.location.pathname),
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
