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
//
// Two other params describe the SCREEN, not the page, and cross both links: `transport`
// (an Ultritouch panel's fallback browser buffers SSE for about a minute and is opened
// as `?transport=poll`) and `text` (its text size). A link that dropped them put the
// page up to a minute late on the very device that needed them, and reset the size.

import { useCallback, useMemo } from "react";

import { useRouterHandle, useSearchParam } from "./use-search-param";

/** The search param naming the page you came from. */
const ORIGIN_PARAM = "from";

/** This page's `transport` and `text`, the params that follow a screen from page to
 *  page (empty when it has neither). Reactive: the text size is rewritten in the
 *  address by the page's own A-/A+. */
function useCarriedQuery(): URLSearchParams {
  const [transport] = useSearchParam("transport");
  const [text] = useSearchParam("text");
  return useMemo(() => {
    const q = new URLSearchParams();
    if (transport !== null) q.set("transport", transport);
    if (text !== null) q.set("text", text);
    return q;
  }, [transport, text]);
}

/** `href` followed by `q`, joined with "?" or "&" as `href` needs; `href` alone when `q`
 *  is empty. */
function withQuery(href: string, q: URLSearchParams): string {
  const query = q.toString();
  return query ? `${href}${href.includes("?") ? "&" : "?"}${query}` : href;
}

/**
 * For a page that links INTO one with a back arrow: returns a function that
 * stamps the link with this page's own path, so the arrow can lead back here.
 */
export function useOriginHref(): (href: string) => string {
  const router = useRouterHandle();
  const carried = useCarriedQuery();
  return useCallback(
    (href) => {
      const origin = router ? router.state.location.pathname : window.location.pathname;
      const q = new URLSearchParams({ [ORIGIN_PARAM]: origin });
      carried.forEach((v, k) => q.set(k, v));
      return withQuery(href, q);
    },
    [router, carried],
  );
}

/**
 * For a page with a back arrow: the page you came from, or `fallback` when the
 * address names none, or names a page that is not one of `allowed`.
 *
 * The address is anyone's to write and the result becomes an `href`, so it is
 * never used as given: it only selects one of the caller's own paths, and the
 * href is that constant, followed only by the carried params, re-encoded.
 */
export function useBackHref(fallback: string, allowed: readonly string[]): string {
  const [from] = useSearchParam(ORIGIN_PARAM);
  const carried = useCarriedQuery();
  return withQuery(allowed.find((p) => p === from) ?? fallback, carried);
}
