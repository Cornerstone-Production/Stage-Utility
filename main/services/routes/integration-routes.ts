// integration-routes.ts — Integrations, wireless, OSC
//
// Integration config/enable/test, wireless connections, and OSC targets.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { errorMessage } from "../errors.js";
import { type RouteCtx, json, error, readBody } from "./context.js";
import { integrationManager } from "../integration-manager.js";
import { deviceManager } from "../device-manager.js";
import { wirelessManager } from "../wireless-manager.js";
import { oscManager } from "../osc-manager.js";

export async function integrationRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
    // ── Integrations ──────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/integrations") {
      json(res, {
        descriptors: integrationManager.getDescriptors(),
        states: integrationManager.getStates(),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/integrations/wireless/channels") {
      const channels = await deviceManager.listChannels();
      json(res, channels);
      return;
    }

    // ── Wireless connections ───────────────────────────────────────────────

    if (method === "GET" && pathname === "/api/wireless/meter-rate") {
      json(res, { ms: wirelessManager.getMeterRate() });
      return;
    }

    if (method === "POST" && pathname === "/api/wireless/meter-rate") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.ms !== "number" || !Number.isFinite(body.ms) || body.ms < 0) {
        error(res, "body.ms (non-negative number) required");
        return;
      }
      const result = await wirelessManager.setMeterRate(body.ms);
      json(res, result);
      return;
    }

    if (method === "GET" && pathname === "/api/wireless/providers") {
      json(res, wirelessManager.listProviders());
      return;
    }

    if (method === "GET" && pathname === "/api/wireless/connections") {
      json(res, wirelessManager.listConnections());
      return;
    }

    if (method === "POST" && pathname === "/api/wireless/connections") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const providerId = typeof body.providerId === "string" ? body.providerId : undefined;
      const connections = await wirelessManager.addConnection({ name, providerId });
      json(res, connections, 201);
      return;
    }

    // PATCH or POST /api/wireless/connections/:id
    const wirelessConnMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)$/);
    if ((method === "PATCH" || method === "POST") && wirelessConnMatch) {
      const id = wirelessConnMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const rawPatch = (body.patch ?? body) as Record<string, unknown>;
      const patch: {
        name?: string;
        providerId?: string;
        enabled?: boolean;
        config?: Record<string, unknown>;
      } = {};
      if (typeof rawPatch.name === "string") patch.name = rawPatch.name;
      if (typeof rawPatch.providerId === "string") patch.providerId = rawPatch.providerId;
      if (typeof rawPatch.enabled === "boolean") patch.enabled = rawPatch.enabled;
      if (typeof rawPatch.config === "object" && rawPatch.config !== null) {
        patch.config = rawPatch.config as Record<string, unknown>;
      }
      const connections = await wirelessManager.updateConnection({ id, patch });
      json(res, connections);
      return;
    }

    // DELETE /api/wireless/connections/:id
    const wirelessConnDeleteMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)$/);
    if (method === "DELETE" && wirelessConnDeleteMatch) {
      const id = wirelessConnDeleteMatch[1];
      const connections = await wirelessManager.removeConnection({ id });
      json(res, connections);
      return;
    }

    // POST /api/wireless/connections/:id/test
    const wirelessTestMatch = pathname.match(/^\/api\/wireless\/connections\/([^/]+)\/test$/);
    if (method === "POST" && wirelessTestMatch) {
      const id = wirelessTestMatch[1];
      const result = await wirelessManager.testConnection({ id });
      json(res, result);
      return;
    }

    // ── OSC ────────────────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/osc/targets") {
      json(res, oscManager.listTargets());
      return;
    }
    if (method === "POST" && pathname === "/api/osc/targets") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const targets = await oscManager.addTarget({ name });
      integrationManager.refreshOscSummary();
      json(res, targets, 201);
      return;
    }
    // POST /api/osc/send — { targetId, address, args? }
    if (method === "POST" && pathname === "/api/osc/send") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.targetId !== "string" || typeof body.address !== "string") {
        error(res, "body.targetId (string) and body.address (string) required");
        return;
      }
      const args = Array.isArray(body.args) ? (body.args as OscArg[]) : [];
      try {
        const result = await oscManager.send(body.targetId, body.address, args);
        json(res, result);
      } catch (err) {
        error(res, errorMessage(err));
      }
      return;
    }
    if (method === "GET" && pathname === "/api/osc/feedback-port") {
      json(res, { port: oscManager.getFeedbackPort() });
      return;
    }
    if (method === "POST" && pathname === "/api/osc/feedback-port") {
      const body = await readBody(req) as Record<string, unknown>;
      const port = typeof body.port === "number" ? body.port : parseInt(String(body.port), 10);
      if (!Number.isFinite(port)) {
        error(res, "body.port (number) required");
        return;
      }
      json(res, await oscManager.setFeedbackPort(port));
      return;
    }
    // POST /api/osc/targets/:id/test
    const oscTestMatch = pathname.match(/^\/api\/osc\/targets\/([^/]+)\/test$/);
    if (method === "POST" && oscTestMatch) {
      const result = await oscManager.testTarget({ id: oscTestMatch[1] });
      json(res, result);
      return;
    }
    // PATCH or POST /api/osc/targets/:id
    const oscTargetMatch = pathname.match(/^\/api\/osc\/targets\/([^/]+)$/);
    if ((method === "PATCH" || method === "POST") && oscTargetMatch) {
      const id = oscTargetMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const rawPatch = (body.patch ?? body) as Record<string, unknown>;
      const patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> } = {};
      if (typeof rawPatch.name === "string") patch.name = rawPatch.name;
      if (typeof rawPatch.enabled === "boolean") patch.enabled = rawPatch.enabled;
      if (typeof rawPatch.config === "object" && rawPatch.config !== null) {
        patch.config = rawPatch.config as Record<string, unknown>;
      }
      const targets = await oscManager.updateTarget({ id, patch });
      integrationManager.refreshOscSummary();
      json(res, targets);
      return;
    }
    // DELETE /api/osc/targets/:id
    if (method === "DELETE" && oscTargetMatch) {
      const targets = await oscManager.removeTarget({ id: oscTargetMatch[1] });
      integrationManager.refreshOscSummary();
      json(res, targets);
      return;
    }

    // POST /api/integrations/:id/config
    const configMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/config$/);
    if (method === "POST" && configMatch) {
      const id = configMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.config !== "object" || body.config === null) {
        error(res, "body.config (object) required");
        return;
      }
      const state = await integrationManager.setConfig(
        id,
        body.config as Record<string, unknown>,
      );
      json(res, state);
      return;
    }

    // POST /api/integrations/:id/enabled
    const enabledMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/enabled$/);
    if (method === "POST" && enabledMatch) {
      const id = enabledMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.enabled !== "boolean") {
        error(res, "body.enabled (boolean) required");
        return;
      }
      const state = await integrationManager.setEnabled(id, body.enabled);
      json(res, state);
      return;
    }

    // POST /api/integrations/:id/test
    const testMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/test$/);
    if (method === "POST" && testMatch) {
      const id = testMatch[1];
      const result = await integrationManager.test(id);
      json(res, result);
      return;
    }

}
