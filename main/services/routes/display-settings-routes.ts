// display-settings-routes.ts — Per-display toggles
//
// Small display-facing switches: QR visibility, onboarding dismissal, forced
// refresh, NDI visibility, public URL and caption colours.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error, readBody } from "./context.js";
import { stageController } from "../stage-controller.js";

export async function displaySettingsRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
    // ── QR visibility ─────────────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/show-qr") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.show !== "boolean") {
        error(res, "body.show (boolean) required");
        return;
      }
      const state = await stageController.setShowQr(body.show);
      json(res, state);
      return;
    }

    // ── Onboarding checklist dismissal ─────────────────────────────────────
    if (method === "POST" && pathname === "/api/onboarding-dismissed") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.dismissed !== "boolean") {
        error(res, "body.dismissed (boolean) required");
        return;
      }
      const state = await stageController.setOnboardingDismissed(body.dismissed);
      json(res, state);
      return;
    }

    // ── Remote display refresh ──────────────────────────────────────────────
    // POST /api/displays/refresh — reload kiosk pages. Optional body.id targets
    // a single output; omitted/empty reloads all connected displays.
    if (method === "POST" && pathname === "/api/displays/refresh") {
      const body = await readBody(req) as Record<string, unknown>;
      const target = typeof body.id === "string" ? body.id : "";
      stageController.refreshDisplays(target);
      json(res, { ok: true, target: target || "all" });
      return;
    }

    // ── NDI visibility ──────────────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/ndi-enabled") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.enabled !== "boolean") {
        error(res, "body.enabled (boolean) required");
        return;
      }
      const state = await stageController.setNdiEnabled(body.enabled);
      json(res, state);
      return;
    }

    // ── Public URL (DNS) ────────────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/public-url") {
      const body = await readBody(req) as Record<string, unknown>;
      const url = typeof body.url === "string" ? body.url : null;
      const state = await stageController.setPublicUrl(url);
      json(res, state);
      return;
    }

    // ── Caption channel colors ──────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/caption-colors") {
      const body = await readBody(req) as Record<string, unknown>;
      const channel = typeof body.channel === "string" ? body.channel : "";
      const color = typeof body.color === "string" ? body.color : null;
      const state = await stageController.setCaptionChannelColor(channel, color);
      json(res, state);
      return;
    }

}
