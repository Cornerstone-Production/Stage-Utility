// qsys-routes.ts — the Q-SYS connection, catalog, allowlist, writes and write log.
//
// Every route must finish responding before it returns (see RouteCtx).
//
//   GET  /api/qsys/status              the connection, plus `writable`: connected and re-read
//   GET  /api/qsys/catalog             { designCode, components }; 503 while not connected
//   POST /api/qsys/catalog/refresh     reads the catalog again; 503 while not connected, 502 on failure
//   GET  /api/qsys/allowlist           { entries, invalid }: invalid says why a stored file is refused, else null
//   PUT  /api/qsys/allowlist           { entries, replaceInvalid? } -> { entries }; 400 naming the first broken
//                                      entry; 409 over an invalid stored file unless replaceInvalid is true
//   POST /api/qsys/allowlist/export    the allowlist file
//   POST /api/qsys/allowlist/import    an allowlist file (+ replaceInvalid?) -> { entries }; 400 keeps the old list; 409 as PUT
//   POST /api/qsys/write               { component, control, value, panelId?, final? } -> WriteResult;
//                                      body capped at 16 KB (413)
//   GET  /api/qsys/values?panel=<id>   { ready, values }: the panel's values as last read; 404 unknown panel
//   GET  /api/qsys/bindings            the binding check: [{ panelId, objectId, address, problem }]; 503 while not connected
//   GET  /api/qsys/write-log           { entries, saveError }
//
// Not PIN-gated: the allowlist and its limits are open like every other
// settings route (the PIN guards only a volunteer panel's way out). Every field
// is checked here, and again by the writer.

import type * as http from "node:http";
import { errorMessage } from "../errors.js";
import { oneLine, scrub } from "../scrub.js";
import { AllowlistRefused, AllowlistStoredInvalid, isLine, qsysAllowlist } from "../qsys/qsys-allowlist-store.js";
import { qsysBindings } from "../qsys/qsys-bindings.js";
import { qsysService } from "../qsys/qsys-service.js";
import { qsysWatch } from "../qsys/qsys-watch.js";
import { writeControl } from "../qsys/qsys-write.js";
import { qsysWriteLog } from "../qsys/qsys-write-log.js";
import { type RouteCtx, error, json, readObjectBody, remoteAddressOf } from "./context.js";

const MAX_DEVICE = 200;
/** A write body is a few hundred bytes; anything past this is answered 413. */
export const MAX_WRITE_BODY_BYTES = 16 * 1024;
const MAX_PANEL_ID = 200;

/** The request's remote address, bounded, on one line. */
export function remoteOf(req: http.IncomingMessage): string {
  return oneLine(remoteAddressOf(req)).slice(0, 64);
}

/** Who sent a write, for the write log: the address and user agent, one bounded line. */
export function deviceOf(req: http.IncomingMessage): string {
  const agent = String(req.headers["user-agent"] ?? "");
  return oneLine(`${remoteOf(req)} ${agent}`).trim().slice(0, MAX_DEVICE);
}

async function allowlistChange(c: RouteCtx, change: (body: Record<string, unknown>, opts: { replaceInvalid: boolean }) => Promise<unknown>): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  if (body.replaceInvalid !== undefined && typeof body.replaceInvalid !== "boolean") return error(c.res, "replaceInvalid must be true or false");
  try {
    json(c.res, { entries: await change(body, { replaceInvalid: body.replaceInvalid === true }) });
  } catch (err) {
    if (err instanceof AllowlistStoredInvalid) return error(c.res, err.message, 409);
    if (!(err instanceof AllowlistRefused)) throw err;
    error(c.res, err.message);
  }
}

export async function qsysRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method, url } = c;
  if (!pathname.startsWith("/api/qsys/")) return;

  if (method === "GET" && pathname === "/api/qsys/status") {
    json(res, { ...qsysService.getStatus(), writable: qsysWatch.ready() });
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
      // The reason can name the Core's address: /log gets it, the page a fixed phrase.
      console.warn(`[qsys] catalog refresh failed: ${scrub(errorMessage(err))}`);
      error(res, "the catalog could not be read from the Core; see /log", 502);
    }
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/allowlist") {
    json(res, await qsysAllowlist.state());
    return;
  }

  if (method === "PUT" && pathname === "/api/qsys/allowlist") {
    return allowlistChange(c, (body, opts) => qsysAllowlist.replace(body.entries, opts));
  }

  if (method === "POST" && pathname === "/api/qsys/allowlist/export") {
    json(res, await qsysAllowlist.exportFile());
    return;
  }

  if (method === "POST" && pathname === "/api/qsys/allowlist/import") {
    return allowlistChange(c, (body, opts) => qsysAllowlist.importFile(body, opts));
  }

  if (method === "POST" && pathname === "/api/qsys/write") {
    const body = await readObjectBody(req, res, MAX_WRITE_BODY_BYTES);
    if (!body) return;
    const { component, control, value, final } = body;
    const panelId = body.panelId ?? null;
    if (typeof component !== "string" || typeof control !== "string") return error(res, "component and control must be text");
    if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") {
      return error(res, "value must be a number, true or false, or text");
    }
    if (panelId !== null && !isLine(panelId, MAX_PANEL_ID)) {
      return error(res, `panelId must be null or text of up to ${MAX_PANEL_ID} characters on one line`);
    }
    if (final !== undefined && typeof final !== "boolean") return error(res, "final must be true or false");
    json(res, await writeControl({ component, control, value, panelId, device: deviceOf(req), remote: remoteOf(req), final }));
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/values") {
    const panel = url.searchParams.get("panel");
    if (!panel) return error(res, "panel is required");
    const addresses = qsysWatch.panelAddresses(panel);
    if (!addresses) return error(res, "no Q-SYS panel has that id", 404);
    // current() is keyed by address, so a control on a panel twice is one value.
    const values = [...qsysWatch.current(addresses).values()].map((v) => ({
      component: v.Component,
      control: v.Name,
      value: v.Value,
      string: v.String,
      position: v.Position,
    }));
    json(res, { ready: qsysWatch.ready(), values });
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/bindings") {
    // Read only: the check reruns when the views, the allowlist or the catalog change.
    await qsysBindings.settled();
    const report = qsysBindings.current();
    if (!report) return error(res, "the Q-SYS Core is not connected", 503);
    json(res, report);
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/write-log") {
    json(res, await qsysWriteLog.list());
    return;
  }
}
