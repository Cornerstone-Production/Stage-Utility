// Which URLs serve the log viewer.
//
// Its own module, next to operator-paths.ts and for the same reason: the route
// that serves these paths and the slug validator that must refuse them are in
// different halves of the app, and a page whose path is not reserved can be
// silently shadowed by a display slug. One list, imported by both.
//
// Deliberately dependency-free. reserved-slugs.ts imports it, and log-routes.ts
// pulls in the integration manager — routing that graph into slug validation
// would be a lot of app to load in order to answer "is this name taken".

/** `/log` is canonical. `/logs` redirects to it, query string intact. */
export const LOG_PAGE_PATHS = ["/log", "/logs"] as const;

export const CANONICAL_LOG_PATH = "/log";
