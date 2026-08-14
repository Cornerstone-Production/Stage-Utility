// Which URLs belong to the operator app (app.html) rather than the kiosk
// (index.html) or the settings panel (settings-window.html).
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
  return OPERATOR_PATHS.some(
    (p) => clean === p || clean === `${p}/` || clean.startsWith(`${p}/`),
  );
}
