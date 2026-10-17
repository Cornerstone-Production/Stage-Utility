// branding-routes.ts — Branding
//
// App name and logo images.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error, readBody, MAX_IMAGE_BODY_BYTES } from "./context.js";
import { stageController } from "../stage-controller.js";
import { parseAppIcon } from "../app-icon.js";
import { isStoredBrandingImage, looksLikeStoredRef } from "../branding-image-store.js";

export async function brandingRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, url, method } = c;
    // ── Branding (app name + logos) ─────────────────────────────────────────
    if (method === "GET" && pathname === "/api/branding/source") {
      const t = url.searchParams.get("target");
      const target = t === "empty" ? "empty" : t === "avatar" ? "avatar" : t === "icon" ? "icon" : "app";
      json(res, await stageController.getBrandingSource(target));
      return;
    }

    if (method === "POST" && pathname === "/api/branding") {
      // Carries data-URL logos, so it needs headroom over the plain-JSON cap.
      const body = await readBody(req, MAX_IMAGE_BODY_BYTES) as Record<string, unknown>;
      const partial: Record<string, unknown> = {};
      if (typeof body.name === "string") partial.name = body.name;
      if (typeof body.monochrome === "boolean") partial.monochrome = body.monochrome;
      if ("accentColor" in body) {
        const v = body.accentColor;
        if (v === null) partial.accentColor = null;
        else if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) partial.accentColor = v;
        else {
          error(res, "body.accentColor must be a #rrggbb hex or null");
          return;
        }
      }

      // Validate a data-URL image field; cap size so it can't bloat storage.
      //
      // An `*Original` also accepts a stored reference. The editor reopens an image
      // from GET /api/branding/source, which hands back `/branding-images/<hash>`,
      // and saves that same value back with the new crop: refusing it made every
      // Adjust fail with a 400 (the pre-crop original is only ever stored as a file
      // once it has been saved once). It must be a file this store actually holds.
      const validateImage = async (
        key: "logo" | "logoOriginal" | "emptyLogo" | "emptyLogoOriginal" | "avatar" | "avatarOriginal",
      ): Promise<boolean> => {
        if (!(key in body)) return true;
        const v = body[key];
        if (v === null) {
          partial[key] = null;
          return true;
        }
        if (key.endsWith("Original") && looksLikeStoredRef(v)) {
          if (!(await isStoredBrandingImage(v))) {
            error(res, `body.${key} names an image that is not stored`);
            return false;
          }
          partial[key] = v;
          return true;
        }
        if (typeof v !== "string" || !v.startsWith("data:image/")) {
          error(res, `body.${key} must be an image data URL${key.endsWith("Original") ? ", a stored image" : ""} or null`);
          return false;
        }
        if (v.length > 2_000_000) {
          error(res, `${key} too large (max ~1.5 MB)`);
          return false;
        }
        partial[key] = v;
        return true;
      };
      if (!(await validateImage("logo"))) return;
      if (!(await validateImage("logoOriginal"))) return;
      if (!(await validateImage("emptyLogo"))) return;
      if (!(await validateImage("emptyLogoOriginal"))) return;
      if (!(await validateImage("avatar"))) return;
      if (!(await validateImage("avatarOriginal"))) return;

      const readCrop = (key: "logoCrop" | "emptyLogoCrop" | "avatarCrop"): void => {
        if (!(key in body)) return;
        const c = body[key] as Record<string, unknown> | null;
        partial[key] =
          c && typeof c.scale === "number" && typeof c.x === "number" && typeof c.y === "number"
            ? { scale: c.scale, x: c.x, y: c.y }
            : null;
      };
      readCrop("logoCrop");
      readCrop("emptyLogoCrop");
      readCrop("avatarCrop");

      // The tab and home-screen icon is validated as one unit (see app-icon.ts).
      if ("icon" in body) {
        const icon = parseAppIcon(body.icon);
        if (!icon.ok) {
          error(res, icon.error);
          return;
        }
        if (icon.value?.original && looksLikeStoredRef(icon.value.original) && !(await isStoredBrandingImage(icon.value.original))) {
          error(res, "body.icon.original names an image that is not stored");
          return;
        }
        partial.icon = icon.value;
      }

      const state = await stageController.setBranding(
        partial as Parameters<typeof stageController.setBranding>[0],
      );
      json(res, state);
      return;
    }

}
