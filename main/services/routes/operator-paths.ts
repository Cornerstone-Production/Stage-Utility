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
  "/scriptview",
  "/automation",
  "/plan",
  "/screens",
  "/signage",
  // A console, in the shell. Without this the server serves the KIOSK bundle for
  // a direct load of /consoles/…, which only shows up on a reload or a pasted
  // link — client-side navigation from the rail works either way, so it hides.
  "/consoles",
  // Kept so the paths they replaced still redirect rather than 404.
  "/views",
  "/displays",
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
