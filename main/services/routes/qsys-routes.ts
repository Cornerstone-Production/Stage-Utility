// qsys-routes.ts — the Q-SYS connection, catalog, allowlist, writes and write log.
//
// Every route must finish responding before it returns (see RouteCtx).
//
//   GET  /api/qsys/status              the connection, plus `writable`: connected and re-read
//   GET  /api/qsys/catalog             { designCode, components }; 503 while not connected
//   POST /api/qsys/catalog/refresh     reads the catalog again; 503 while not connected, 502 on failure
//   GET  /api/qsys/allowlist           { entries }
//   PUT  /api/qsys/allowlist           { entries } -> { entries }; 400 naming the first broken entry
//   POST /api/qsys/allowlist/export    the allowlist file
//   POST /api/qsys/allowlist/import    an allowlist file -> { entries }; 400 keeps the old list
//   POST /api/qsys/write               { component, control, value, panelId? } -> WriteResult
//   GET  /api/qsys/values?panel=<id>   { ready, values }: the panel's values as last read; 404 unknown panel
//   GET  /api/qsys/write-log           { entries, saveError }
//
// Not PIN-gated: the allowlist and its limits are open like every other
// settings route (the PIN guards only a volunteer panel's way out). Every field
// is checked here, and again by the writer.

import type * as http from "node:http";
import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";
import { addressKey } from "../../types/qsys.js";
import { AllowlistRefused, qsysAllowlist } from "../qsys/qsys-allowlist-store.js";
import { qsysService } from "../qsys/qsys-service.js";
import { qsysWatch } from "../qsys/qsys-watch.js";
import { writeControl } from "../qsys/qsys-write.js";
import { qsysWriteLog } from "../qsys/qsys-write-log.js";
import { type RouteCtx, error, json, readObjectBody } from "./context.js";

const MAX_DEVICE = 200;
const MAX_PANEL_ID = 200;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS = new RegExp(CONTROL_CHAR.source, "g");

/** Who sent a write, for the write log: the address and user agent, one bounded line. */
export function deviceOf(req: http.IncomingMessage): string {
  const address = req.socket?.remoteAddress ?? "unknown";
  const agent = String(req.headers["user-agent"] ?? "");
  return `${address} ${agent}`.replace(CONTROL_CHARS, " ").trim().slice(0, MAX_DEVICE);
}

async function allowlistChange(c: RouteCtx, change: (body: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  try {
    json(c.res, { entries: await change(body) });
  } catch (err) {
    if (!(err instanceof AllowlistRefused)) throw err;
    error(c.res, err.message);
  }
}

export async function qsysRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method, url } = c;
  if (!pathname.startsWith("/api/qsys/")) return;

  if (method === "GET" && pathname === "/api/qsys/status") {
    json(res, { ...qsysService.getStatus(), writable: !!qsysService.transport && qsysWatch.ready() });
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/catalog") {
    const catalog = qsysService.getCatalog();
    if (!catalog) return error(res, "the Q-SYS Core is not connected", 503);
    json(res, catalog);
    return;
  }

  if (method === "POST" && pathname === "/api/qsys/catalog/refresh") {
    if (!qsysService.transport) return error(res, "the Q-SYS Core is not connected", 503);
    try {
      json(res, await qsysService.refreshCatalog());
    } catch (err) {
      console.warn(`[qsys] catalog refresh failed: ${scrub(errorMessage(err))}`);
      error(res, errorMessage(err), 502);
    }
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/allowlist") {
    json(res, { entries: await qsysAllowlist.list() });
    return;
  }

  if (method === "PUT" && pathname === "/api/qsys/allowlist") {
    return allowlistChange(c, (body) => qsysAllowlist.replace(body.entries));
  }

  if (method === "POST" && pathname === "/api/qsys/allowlist/export") {
    json(res, await qsysAllowlist.exportFile());
    return;
  }

  if (method === "POST" && pathname === "/api/qsys/allowlist/import") {
    return allowlistChange(c, (body) => qsysAllowlist.importFile(body));
  }

  if (method === "POST" && pathname === "/api/qsys/write") {
    const body = await readObjectBody(req, res);
    if (!body) return;
    const { component, control, value } = body;
    const panelId = body.panelId ?? null;
    if (typeof component !== "string" || typeof control !== "string") return error(res, "component and control must be text");
    if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") {
      return error(res, "value must be a number, true or false, or text");
    }
    if (panelId !== null && (typeof panelId !== "string" || panelId.length > MAX_PANEL_ID || CONTROL_CHAR.test(panelId))) {
      return error(res, `panelId must be null or text of up to ${MAX_PANEL_ID} characters on one line`);
    }
    json(res, await writeControl({ component, control, value, panelId, device: deviceOf(req) }));
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/values") {
    const panel = url.searchParams.get("panel");
    if (!panel) return error(res, "panel is required");
    const addresses = qsysWatch.panelAddresses(panel);
    if (!addresses) return error(res, "no Q-SYS panel has that id", 404);
    const read = qsysWatch.current(addresses);
    const seen = new Set<string>();
    const values = addresses.flatMap((a) => {
      const k = addressKey(a);
      const v = read.get(k);
      if (!v || seen.has(k)) return [];
      seen.add(k);
      return [{ component: a.component, control: a.control, value: v.Value, string: v.String, position: v.Position }];
    });
    json(res, { ready: !!qsysService.transport && qsysWatch.ready(), values });
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/write-log") {
    json(res, await qsysWriteLog.list());
    return;
  }
}
