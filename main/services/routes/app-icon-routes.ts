// app-icon-routes.ts — the web app manifest, and the app icons when the operator
// has set their own.
//
// The paths are the ones the HTML documents and the manifest have always named.
// With no custom icon set, a request for one falls through (this module does not
// respond) and the static handler serves the built-in file, so an install that
// never touches the icon behaves exactly as before. The manifest always answers
// here, because it carries the app name.
//
// Runs in EARLY_ROUTE_MODULES (remote-server.ts): the static arm answers any path
// that names a file in the build, so a handler after it would never be reached.

import type { RouteCtx } from "./context.js";
import { BRANDING_IMAGE_DIR } from "../branding-image-store.js";
import { buildManifest, ICON_ROUTES, MANIFEST_PATH } from "../install-metadata.js";
import { readImage } from "../image-files.js";
import { scrub } from "../scrub.js";
import { settingsStore } from "../settings-store.js";
import { stageController } from "../stage-controller.js";

/** References already reported as unreadable, by path: one line per failure, not
 *  one per request (a phone asks for these on every launch). */
const reported = new Map<string, string>();

export async function appIconRoutes({ res, pathname, method }: RouteCtx): Promise<void> {
  if (method !== "GET") return;

  if (pathname === MANIFEST_PATH) {
    res.writeHead(200, {
      "Content-Type": "application/manifest+json",
      // A renamed app or a new icon must show up on the next install, not after
      // a cache expires.
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(buildManifest(stageController.getState().appName)));
    return;
  }

  if (!Object.hasOwn(ICON_ROUTES, pathname)) return;
  const field = ICON_ROUTES[pathname as keyof typeof ICON_ROUTES];
  const ref = (await settingsStore.get())[field];
  if (!ref) return; // no custom icon: the built-in file answers

  const img = await readImage(BRANDING_IMAGE_DIR, ref.split("/").pop() ?? "");
  if (!img) {
    // A stored reference whose file is gone (a restore that carried the settings
    // and not the images, a deleted data directory file). The built-in icon still
    // answers, so nobody sees a broken icon, but the operator's choice is not
    // being honoured and the log is where they find out.
    if (reported.get(pathname) !== ref) {
      reported.set(pathname, ref);
      console.warn(
        "[branding] a custom icon is set but its file could not be read; serving the built-in icon for",
        scrub(pathname),
        scrub(ref),
      );
    }
    return;
  }
  res.writeHead(200, { "Content-Type": img.mime, "Cache-Control": "no-cache" });
  res.end(img.data);
}
