// headers.ts — what every answer says about itself, and the answers the Worker
// builds more than once.

import { PUBLIC_STATIC_FILES, STATIC_ASSET_PREFIX } from "../../../main/types/servicecue-publish.js";

/**
 * On EVERY response the Worker sends, whatever route made it: the page is not for
 * search engines, a browser takes a response for what it says it is, a link out of
 * the page does not tell the next site where it came from, and a browser that has
 * been here once comes back over https only, whatever the zone's own settings say.
 * Sorted by name.
 */
export const BASE_HEADERS: readonly (readonly [name: string, value: string])[] = [
  ["Referrer-Policy", "no-referrer"],
  ["Strict-Transport-Security", "max-age=15552000; includeSubDomains"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Robots-Tag", "noindex"],
];

/** The file in the static assets that the asset service reads its headers from. */
export const STATIC_HEADERS_FILE = "_headers";

/**
 * The text of that file: what the asset service says about the files it answers
 * without the Worker (wrangler.jsonc names them). The same base headers the Worker puts
 * on its own answers, and each kind of file's caching: hashed files under /assets/ are
 * immutable, the icons and the manifest are asked about again.
 */
export function staticHeaders(): string {
  const rule = (path: string, cache: string) =>
    [path, ...[["Cache-Control", cache], ...BASE_HEADERS].map(([name, value]) => `  ${name}: ${value}`)].join("\n");
  const rules = [rule(`${STATIC_ASSET_PREFIX}*`, "public, max-age=31536000, immutable"), ...PUBLIC_STATIC_FILES.map((file) => rule(file, "no-cache"))];
  return `${rules.join("\n\n")}\n`;
}

/**
 * On an SVG asset. An SVG can carry script, and opened as a page of its own it would
 * run as this origin; sandboxed with nothing allowed, it is only a picture. As an
 * `<img>` or a CSS mask, which is all the page ever does with one, it is unaffected.
 */
export const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/**
 * The policy on the viewer's document. Everything comes from this origin, there is
 * no inline script (the document has none), and it cannot be framed.
 *
 * `connect-src 'self'` is meant to cover the page's own socket. It does in Chrome
 * and in a current WebKit (both driven with 'self' alone; the socket opened and
 * delivered frames). Safari did not for years (WebKit bug 235873), and the older
 * releases are the ones still on stage iPads, so the socket's address is named
 * too: the same host, nothing wider.
 */
export function htmlCsp(url: URL): string {
  const socket = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  return [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${socket}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * `response` with BASE_HEADERS on it. A copy, because the headers of a response
 * that came from fetch or the static assets are immutable. The one response it
 * leaves alone is a WebSocket handshake (101): there is no document there for a
 * header to protect, and the runtime does not take one rebuilt.
 */
export function secured(response: Response): Response {
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  for (const [name, value] of BASE_HEADERS) out.headers.set(name, value);
  return out;
}

/** An answer whose body is JSON text already. Never cached: every one of these is a live reading or a refusal. */
export function jsonText(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

/** A JSON answer. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return jsonText(JSON.stringify(body), status, headers);
}

/** An answer with no body: 204 for a write that took. */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
