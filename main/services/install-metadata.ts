// install-metadata.ts — what a phone or browser reads to name and draw the app when
// it is added to a home screen: the web app manifest, and the two names the HTML
// documents carry.
//
// The app name is the operator's (Branding → App name), so none of this can be a
// static file. The icons are not here: the manifest and the HTML name the same
// /icon-*.png and /apple-touch-icon.png paths whether or not an operator has set a
// custom icon, and app-icon-routes.ts decides which bytes each path answers with.

import type { AppIconSettings } from "./app-icon.js";

export const MANIFEST_PATH = "/manifest.webmanifest";

/** The public paths a custom icon is served at, and the settings field behind each.
 *  The paths are the ones the HTML documents and the manifest already name, so a
 *  custom icon needs no change to either beyond the app name. */
export const ICON_ROUTES = {
  "/apple-touch-icon.png": { field: "appIconApple" },
  "/icon-192.png": { field: "appIcon192" },
  "/icon-512.png": { field: "appIcon512" },
  "/icon-maskable-512.png": { field: "appIconMaskable" },
} as const satisfies Record<string, { field: keyof AppIconSettings }>;

export type IconRoutePath = keyof typeof ICON_ROUTES;

/** The manifest for an app called `appName`. The name is the label under the icon
 *  on Android and the title of the installed window. */
export function buildManifest(appName: string): Record<string, unknown> {
  return {
    name: appName,
    short_name: appName,
    start_url: "/",
    display: "standalone",
    background_color: "#0e0e0e",
    theme_color: "#0e0e0e",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const IOS_TITLE = /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/;
const PAGE_TITLE = /(<title>)[^<]*(<\/title>)/;

/**
 * Put the app name into an HTML document's `apple-mobile-web-app-title` and
 * `<title>`.
 *
 * iOS reads the home-screen label from the document when the app is ADDED, before
 * any script has run, so setting it from the renderer would be too late. The
 * replacements are functions, not strings: a name containing `$&` would otherwise
 * be read as a replacement pattern.
 */
export function brandHtml(html: string, appName: string): string {
  const name = escapeAttr(appName);
  return html.replace(IOS_TITLE, (_m, open: string, close: string) => `${open}${name}${close}`).replace(
    PAGE_TITLE,
    (_m, open: string, close: string) => `${open}${name}${close}`,
  );
}
