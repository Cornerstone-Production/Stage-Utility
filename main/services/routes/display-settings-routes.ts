// display-settings-routes.ts — Per-display toggles
//
// Small display-facing switches: QR visibility, onboarding dismissal, forced
// refresh, NDI visibility, public URL and caption colors.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { errorMessage } from "../errors.js";
import { type RouteCtx, json, error, readBody } from "./context.js";
import { stageController } from "../stage-controller.js";

export async function displaySettingsRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
    // ── Context bar items ─────────────────────────────────────────────────
    // Which items appear and in what order. Global config, so every operator
    // reads the same strip.
    if (method === "POST" && pathname === "/api/bar-items") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.items) || body.items.some((i) => typeof i !== "string")) {
        error(res, "body.items (string[]) required");
        return;
      }
      json(res, await stageController.setBarItems(body.items as string[]));
      return;
    }

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

    // ── Baptism auto-start ──────────────────────────────────────────────────
    //
    // stageController.setBaptismAutoStart existed with no route and no caller in
    // main/ at all: the client posted to /api/settings/baptism-auto-start, which
    // no module handled, so the operator got a 404 toast and the setting never
    // persisted. Filed here beside the other settings setters rather than under
    // /api/settings/, which was a path shape nothing else in this app uses.
    if (method === "POST" && pathname === "/api/baptism-auto-start") {
      const body = await readBody(req) as Record<string, unknown>;
      const patch: Parameters<typeof stageController.setBaptismAutoStart>[0] = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.testimonyKeyword === "string") patch.testimonyKeyword = body.testimonyKeyword;
      if (Object.keys(patch).length === 0) {
        error(res, "body.enabled (boolean) or body.testimonyKeyword (string) required");
        return;
      }
      json(res, await stageController.setBaptismAutoStart(patch));
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

    // ── Icon tint (display id or tool path) ─────────────────────────────────
    if (method === "POST" && pathname === "/api/icon-color") {
      const body = await readBody(req) as Record<string, unknown>;
      const key = typeof body.key === "string" ? body.key : "";
      const color = typeof body.color === "string" ? body.color : "";
      try {
        json(res, await stageController.setIconColor(key, color));
      } catch (err) {
        error(res, errorMessage(err));
      }
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
