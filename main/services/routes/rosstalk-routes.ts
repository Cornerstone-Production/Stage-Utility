// rosstalk-routes.ts — RossTalk targets, catalogue, simulate flag and send.
//
// Every route must finish responding before it returns (see RouteCtx).

import { type RouteCtx, json, error, readBody, readBodyOrEmpty } from "./context.js";
import { ROSSTALK_COMMANDS, commandsForFamily } from "../rosstalk-commands.js";
import { rosstalkManager } from "../rosstalk-manager.js";

export async function rosstalkRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, url, method } = c;

  if (method === "GET" && pathname === "/api/rosstalk/targets") {
    json(res, { targets: rosstalkManager.listTargets(), simulate: rosstalkManager.getSimulate() });
    return;
  }

  if (method === "POST" && pathname === "/api/rosstalk/targets") {
    const body = await readBodyOrEmpty(req);
    const name = typeof body.name === "string" ? body.name : undefined;
    json(res, await rosstalkManager.addTarget({ name }), 201);
    return;
  }

  const idMatch = pathname.match(/^\/api\/rosstalk\/targets\/([^/]+)$/);
  if (method === "PATCH" && idMatch) {
    const body = (await readBody(req)) as Record<string, unknown>;
    json(res, await rosstalkManager.updateTarget({ id: idMatch[1], patch: body }));
    return;
  }
  if (method === "DELETE" && idMatch) {
    json(res, await rosstalkManager.removeTarget({ id: idMatch[1] }));
    return;
  }

  const testMatch = pathname.match(/^\/api\/rosstalk\/targets\/([^/]+)\/test$/);
  if (method === "POST" && testMatch) {
    json(res, await rosstalkManager.testTarget({ id: testMatch[1] }));
    return;
  }

  if (method === "GET" && pathname === "/api/rosstalk/commands") {
    // Strip format() — it is a function and cannot cross the wire.
    const family = url.searchParams.get("family");
    const list = family === "carbonite" || family === "ultrix"
      ? commandsForFamily(family)
      : Object.values(ROSSTALK_COMMANDS);
    json(res, list.map(({ id, label, family: f, params, help }) => ({ id, label, family: f, params, help })));
    return;
  }

  if (method === "GET" && pathname === "/api/rosstalk/simulate") {
    json(res, { simulate: rosstalkManager.getSimulate() });
    return;
  }
  if (method === "POST" && pathname === "/api/rosstalk/simulate") {
    const body = (await readBody(req)) as Record<string, unknown>;
    if (typeof body.simulate !== "boolean") {
      error(res, "body.simulate (boolean) required");
      return;
    }
    json(res, await rosstalkManager.setSimulate(body.simulate));
    return;
  }

  if (method === "POST" && pathname === "/api/rosstalk/send") {
    const body = (await readBody(req)) as Record<string, unknown>;
    if (typeof body.targetId !== "string") {
      error(res, "body.targetId (string) required");
      return;
    }
    try {
      json(
        res,
        await rosstalkManager.send(body.targetId, {
          commandId: typeof body.commandId === "string" ? body.commandId : undefined,
          params: (body.params as Record<string, string | number>) ?? {},
          raw: typeof body.raw === "string" ? body.raw : undefined,
        }),
      );
    } catch (err) {
      // A rejected command is operator error, not a server fault.
      error(res, err instanceof Error ? err.message : String(err), 400);
    }
    return;
  }
}
