// automation-routes.ts — rules, registries, settings, activity log.
//
// Every route must finish responding before it returns (see RouteCtx).

import { type RouteCtx, error, json, readBody } from "./context.js";
import { AUTOMATION_ACTIONS } from "../automation-actions.js";
import { AUTOMATION_CONDITIONS } from "../automation-conditions.js";
import { automationEngine } from "../automation-engine.js";
import { automationLog } from "../automation-log.js";
import { AUTOMATION_TRIGGERS } from "../automation-triggers.js";

/** Strip functions — didFire/holds/run cannot cross the wire. */
const shape = (o: Record<string, { id: string; label: string; params: unknown; help?: string }>) =>
  Object.values(o).map(({ id, label, params, help }) => ({ id, label, params, help }));

export async function automationRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

  if (method === "GET" && pathname === "/api/automation/registry") {
    json(res, {
      triggers: Object.values(AUTOMATION_TRIGGERS).map(({ id, label, channel, params, help }) => ({ id, label, channel, params, help })),
      conditions: shape(AUTOMATION_CONDITIONS),
      actions: shape(AUTOMATION_ACTIONS),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/automation/rules") {
    json(res, { rules: automationEngine.listRules(), settings: automationEngine.getSettings() });
    return;
  }

  if (method === "POST" && pathname === "/api/automation/rules") {
    const body = (await readBody(req)) as Record<string, unknown>;
    if (typeof body.name !== "string" || !body.trigger || !body.action) {
      error(res, "body.name, body.trigger and body.action are required");
      return;
    }
    json(res, await automationEngine.addRule(body as never), 201);
    return;
  }

  const idMatch = pathname.match(/^\/api\/automation\/rules\/([^/]+)$/);
  if (method === "PATCH" && idMatch) {
    const body = (await readBody(req)) as Record<string, unknown>;
    json(res, await automationEngine.updateRule(idMatch[1], body as never));
    return;
  }
  if (method === "DELETE" && idMatch) {
    json(res, await automationEngine.removeRule(idMatch[1]));
    return;
  }

  const testMatch = pathname.match(/^\/api\/automation\/rules\/([^/]+)\/test$/);
  if (method === "POST" && testMatch) {
    try {
      json(res, await automationEngine.testFire(testMatch[1]));
    } catch (err) {
      error(res, err instanceof Error ? err.message : String(err), 400);
    }
    return;
  }

  if (method === "GET" && pathname === "/api/automation/settings") {
    json(res, automationEngine.getSettings());
    return;
  }
  if (method === "POST" && pathname === "/api/automation/settings") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const patch: Record<string, boolean> = {};
    if (typeof body.simulate === "boolean") patch.simulate = body.simulate;
    if (typeof body.disarmed === "boolean") patch.disarmed = body.disarmed;
    json(res, await automationEngine.setSettings(patch));
    return;
  }

  if (method === "GET" && pathname === "/api/automation/log") {
    json(res, { entries: automationLog.list() });
    return;
  }
  if (method === "DELETE" && pathname === "/api/automation/log") {
    await automationLog.clear();
    json(res, { ok: true });
    return;
  }
}
