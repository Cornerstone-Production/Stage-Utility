// Which port the Node server listens on — the ONE derivation.
//
// It lived in two places that could not be moved together: remote-server.ts read
// STAGE_UTILITY_PORT, and vite.config.ts proxied /api to a hard-coded 8788. The
// pairing `npm run server` + `npm run dev` is correct at the default, so the gap
// was invisible until the default was taken — and 8788 is the port every install
// reaches for, so on a machine already running one, the obvious workaround
//
//   STAGE_UTILITY_PORT=8799 npm run server
//
// moved the server and left the dev UI proxying to 8788. The operator then edits
// whatever is answering there, with nothing on screen saying so. That is not
// hypothetical: it is how two empty views were created in a live instance while
// an agent believed it was talking to its own sandbox.
//
// Kept dependency-free on purpose. vite.config.ts imports it at config time,
// before any app module is loaded, the same way it already imports
// operator-paths.ts so dev and prod cannot answer one URL two ways.

/** The default when nothing is set. Every install and every doc names this. */
export const DEFAULT_SERVER_PORT = 8788;

/**
 * The port the server binds and the dev proxy forwards to.
 *
 * `Number("")` is 0 and `Number("nope")` is NaN, both falsy, so a blank or
 * unparseable value falls back rather than binding port 0 — which the OS reads
 * as "any free port" and would put the server somewhere nobody is looking.
 */
export function serverPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.STAGE_UTILITY_PORT) || DEFAULT_SERVER_PORT;
}
