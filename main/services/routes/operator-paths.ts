// Which URLs belong to the operator app (app.html) rather than the kiosk
// (index.html).
//
// Routing is implemented twice — the `cleanUrls` Vite plugin for dev and
// `remote-server.ts` for prod — and the two have drifted before. Both import
// this, so a new operator route is added in exactly one place.

/** Top-level operator surfaces. Nested paths under each are also claimed. */
export const OPERATOR_PATHS = [
  "/history",
  "/baptism",
  "/patch",
  "/servicecue",
  "/automation",
  "/plan",
  "/screens",
  "/video-feeds",
  // A console, in the shell. Without this the server serves the KIOSK bundle for
  // a direct load of /consoles/…, which only shows up on a reload or a pasted
  // link — client-side navigation from the rail works either way, so it hides.
  "/consoles",
  // Kept so the paths they replaced still redirect rather than 404.
  "/views",
  "/displays",
  // Renamed to /servicecue. Answered with a redirect before it is ever served
  // (see legacyPageRedirect); claimed here so a build that lost the redirect
  // still lands in the operator app, whose router redirects it too.
  "/scriptview",
  // The settings panel is no longer its own document; /settings and everything
  // under it are routes in the operator app.
  "/settings",
] as const;

/**
 * Does this pathname belong to the operator app?
 *
 * Matches the exact path, a trailing slash, or a nested route beneath it.
 * Deliberately NOT `startsWith(p)`: that would claim "/historyfoo" and serve it
 * the wrong document. The boundary must be the end of the string or a "/".
 */
export function isOperatorPath(pathname: string): boolean {
  const clean = pathname.split("?")[0].split("#")[0];
  // The root is Home now. Matched exactly and never by prefix: "/" is a prefix
  // of every path, so folding it into the loop below would claim /display-1 and
  // black out every wall screen.
  if (clean === "" || clean === "/") return true;
  return OPERATOR_PATHS.some(
    (p) => clean === p || clean === `${p}/` || clean.startsWith(`${p}/`),
  );
}

/**
 * Page prefixes that moved, old to new. Displays and bookmarks point at the old
 * ones, so they are answered forever.
 *
 * /api/servicecue is NOT here: those are API paths, and they moved with the
 * server and the renderer together.
 */
export const MOVED_PAGE_PREFIXES: readonly (readonly [from: string, to: string])[] = [
  ["/scriptview", "/servicecue"],
];

/**
 * Where a request for a moved page should go, or null when it did not move.
 *
 * `pathname` and `search` are kept verbatim — the rest of the path and the whole
 * query string, including the leading "?" — because a display's address carries
 * state in them (`?plan=`, `?text=`, `?transport=poll`) that must survive the
 * hop. The fragment never reaches a server; a browser carries it across a 301
 * itself. One function, so the server, the dev server and the client router
 * cannot disagree about which URLs moved.
 *
 * Like isOperatorPath, matches the exact path, a trailing slash or a nested
 * route, never a bare prefix: "/scriptviewer" is not "/scriptview".
 */
export function legacyPageRedirect(pathname: string, search = ""): string | null {
  return movedPath(MOVED_PAGE_PREFIXES, pathname, search);
}

/**
 * `pathname` under the prefix that replaced its own, or null when no prefix in
 * `moved` is its. The boundary is the end of the path or a "/", never a bare
 * prefix. Shared by the page and the API redirects, which differ only in table.
 */
export function movedPath(
  moved: readonly (readonly [from: string, to: string])[],
  pathname: string,
  search = "",
): string | null {
  for (const [from, to] of moved) {
    if (pathname === from || pathname.startsWith(`${from}/`)) {
      return `${to}${pathname.slice(from.length)}${search}`;
    }
  }
  return null;
}
