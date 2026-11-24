// qsys-routes.ts — the Q-SYS connection, catalog, allowlist, writes and write log.
//
// Every route must finish responding before it returns (see RouteCtx).
//
//   GET  /api/qsys/status              the connection, plus `writable`: connected and re-read
//   GET  /api/qsys/catalog             { designCode, components }; 503 while not connected
//   POST /api/qsys/catalog/refresh     reads the catalog again; 503 while not connected, 502 on failure
//   GET  /api/qsys/allowlist           { entries, invalid, rev }: invalid says why a stored file is refused, else null
//   PUT  /api/qsys/allowlist           { entries, rev?, replaceInvalid? } -> { entries, rev }; 400 naming the first broken
//                                      entry; 409 over an invalid stored file unless replaceInvalid is true;
//                                      409 code "rev-changed" when rev is not the stored list's revision
//   POST /api/qsys/allowlist/export    the allowlist file
//   POST /api/qsys/allowlist/import    an allowlist file (+ replaceInvalid?, rev?) -> { entries, rev }; 400 keeps the old list; 409 as PUT
//   POST /api/qsys/allowlist/add-panel { panelId } -> { entries, added, skipped }: every control the panel writes
//                                      and the list lacks, at the Core's range; 503 while not connected,
//                                      404 unknown view, 409 over an invalid stored file
//   POST /api/qsys/write               { component, control, value, panelId?, final?, lease?, cid? } -> WriteResult;
//                                      body capped at 16 KB (413)
//   POST /api/qsys/lease               { component, control, cid? } -> { held }: renew a held momentary
//   GET  /api/qsys/values?panel=<id>   { ready, values, catalogAt }: the panel's values as last read; 404 unknown panel
//   GET  /api/qsys/bindings            the binding check: [{ panelId, objectId, address, problem }]; 503 while not
//                                      connected (code not-connected), or while the check cannot read the views
//                                      or the allowlist (code check-failed)
//   GET  /api/qsys/panel-repairs       [{ viewId, name, from, to, why }]: panel blocks the last load of the views repaired
//   GET  /api/qsys/write-log           { entries, saveError }
//   GET  /api/qsys/pin                 { set }: whether a staff PIN is set; never the hash
//   PUT  /api/qsys/pin                 { pin: "<4 digits>" | null } -> { set }; 400 for anything else
//   POST /api/qsys/pin/check           { pin } -> { ok: true } | { ok: false, lockedForMs, notSet? }:
//                                      5 wrong tries in a row from one address lock it for 60 s
//
// Not PIN-gated: the allowlist, its limits and the PIN itself are open like every
// other settings route (the PIN guards only a volunteer panel's way out to the
// app). Every field is checked here, and again by the writer.

import type * as http from "node:http";
import { errorMessage } from "../errors.js";
import { oneLine, scrub } from "../scrub.js";
import { AllowlistRefused, AllowlistRevChanged, AllowlistStoredInvalid, type Saved, allowEntryFromCatalog, isLine, qsysAllowlist, type AllowEntry } from "../qsys/qsys-allowlist-store.js";
import { viewsStore } from "../views-store.js";
import { qsysSlugRepairs } from "../qsys/qsys-slug-repair.js";
import { isReadOnlyDirection } from "../../types/qsys.js";
import { qsysBindings, writeAddressesOf } from "../qsys/qsys-bindings.js";
import { qsysService } from "../qsys/qsys-service.js";
import { qsysWatch } from "../qsys/qsys-watch.js";
import { qsysWriter, writeControl } from "../qsys/qsys-write.js";
import { usableCid } from "../channel-reports.js";
import { qsysWriteLog } from "../qsys/qsys-write-log.js";
import { PIN_DIGITS, checkPin, isPin, pinState, setPin } from "../qsys/qsys-pin.js";
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

async function allowlistChange(c: RouteCtx, change: (body: Record<string, unknown>, opts: { replaceInvalid: boolean; expectRev?: string }) => Promise<Saved>): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  if (body.replaceInvalid !== undefined && typeof body.replaceInvalid !== "boolean") return error(c.res, "replaceInvalid must be true or false");
  if (body.rev !== undefined && !isLine(body.rev, 64)) return error(c.res, "rev must be the revision GET /api/qsys/allowlist answered");
  try {
    json(c.res, await change(body, { replaceInvalid: body.replaceInvalid === true, ...(typeof body.rev === "string" ? { expectRev: body.rev } : {}) }));
  } catch (err) {
    if (err instanceof AllowlistRevChanged) return error(c.res, err.message, 409, "rev-changed");
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
    return allowlistChange(c, (body, opts) => qsysAllowlist.saveChecked(body.entries, opts));
  }

  if (method === "POST" && pathname === "/api/qsys/allowlist/export") {
    json(res, await qsysAllowlist.exportFile());
    return;
  }

  if (method === "POST" && pathname === "/api/qsys/allowlist/import") {
    return allowlistChange(c, (body, opts) => qsysAllowlist.importChecked(body, opts));
  }

  if (method === "POST" && pathname === "/api/qsys/allowlist/add-panel") {
    // "Add all controls this panel uses": every control the panel WRITES, at the Core's own range.
    const body = await readObjectBody(req, res);
    if (!body) return;
    if (!isLine(body.panelId, MAX_PANEL_ID)) return error(res, `panelId must be text of up to ${MAX_PANEL_ID} characters on one line`);
    const catalog = qsysService.getCatalog();
    if (!catalog) return error(res, "the Q-SYS Core is not connected, so its ranges are not known", 503);
    const view = (await viewsStore.loadStrict()).find((v) => v.id === body.panelId);
    if (!view) return error(res, "no view has that id", 404);
    const components = new Map(catalog.components.map((c) => [c.name, new Map(c.controls.map((x) => [x.Name, x]))]));
    const candidates: AllowEntry[] = [];
    const skipped: { component: string; control: string; reason: "not-in-design" | "read-only" }[] = [];
    for (const a of writeAddressesOf(view)) {
      const control = components.get(a.component)?.get(a.control);
      if (!control) skipped.push({ ...a, reason: "not-in-design" });
      else if (isReadOnlyDirection(control.Direction)) skipped.push({ ...a, reason: "read-only" });
      else candidates.push(allowEntryFromCatalog(control, a.component));
    }
    try {
      json(res, { ...(await qsysAllowlist.addMissing(candidates)), skipped });
    } catch (err) {
      if (err instanceof AllowlistStoredInvalid) return error(res, err.message, 409);
      if (!(err instanceof AllowlistRefused)) throw err;
      error(res, err.message);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/qsys/write") {
    const body = await readObjectBody(req, res, MAX_WRITE_BODY_BYTES);
    if (!body) return;
    const { component, control, value, final, lease } = body;
    const cid = body.cid ?? null;
    const panelId = body.panelId ?? null;
    if (typeof component !== "string" || typeof control !== "string") return error(res, "component and control must be text");
    if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") {
      return error(res, "value must be a number, true or false, or text");
    }
    if (panelId !== null && !isLine(panelId, MAX_PANEL_ID)) {
      return error(res, `panelId must be null or text of up to ${MAX_PANEL_ID} characters on one line`);
    }
    if (final !== undefined && typeof final !== "boolean") return error(res, "final must be true or false");
    if (lease !== undefined && typeof lease !== "boolean") return error(res, "lease must be true or false");
    if (cid !== null && !usableCid(cid)) return error(res, "cid must be null or a stream client id");
    json(res, await writeControl({ component, control, value, panelId, device: deviceOf(req), remote: remoteOf(req), final, lease, cid }));
    return;
  }

  if (method === "POST" && pathname === "/api/qsys/lease") {
    // A momentary still held: renew its lease. Only from the address that pressed it.
    const body = await readObjectBody(req, res, MAX_WRITE_BODY_BYTES);
    if (!body) return;
    const { component, control } = body;
    const cid = body.cid ?? null;
    if (typeof component !== "string" || typeof control !== "string") return error(res, "component and control must be text");
    if (cid !== null && !usableCid(cid)) return error(res, "cid must be null or a stream client id");
    json(res, { held: qsysWriter.leases.renew({ component, control }, remoteOf(req), cid) });
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
    // catalogAt: the stamp the status push carries, so a page can tell from its first push whether the catalog is new.
    json(res, { ready: qsysWatch.ready(), values, catalogAt: qsysService.getStatus().catalogAt });
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/bindings") {
    // Read only: the check reruns when the views, the allowlist or the catalog change.
    await qsysBindings.settled();
    const answer = qsysBindings.current();
    if ("report" in answer) return json(res, answer.report);
    // Never an empty report in place of a check that could not run: empty means every binding resolves.
    // The code says which of the two a 503 is.
    error(res, answer.error === "not-connected" ? "the Q-SYS Core is not connected" : "the binding check could not run: the saved views or the allowlist could not be read; see /log", 503, answer.error);
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/panel-repairs") {
    // What the last load of the views changed in panel blocks (a shared address, a
    // block on a view that cannot be a panel). Read only.
    json(res, qsysSlugRepairs());
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/write-log") {
    json(res, await qsysWriteLog.list());
    return;
  }

  if (method === "GET" && pathname === "/api/qsys/pin") {
    json(res, await pinState());
    return;
  }

  if (method === "PUT" && pathname === "/api/qsys/pin") {
    const body = await readObjectBody(req, res);
    if (!body) return;
    if (body.pin !== null && !isPin(body.pin)) return error(res, `pin must be ${PIN_DIGITS} digits, or null to remove it`);
    await setPin(body.pin, remoteOf(req));
    json(res, await pinState());
    return;
  }

  if (method === "POST" && pathname === "/api/qsys/pin/check") {
    const body = await readObjectBody(req, res);
    if (!body) return;
    if (typeof body.pin !== "string" || body.pin.length > 16) return error(res, "pin must be text");
    json(res, await checkPin(body.pin, remoteOf(req)));
    return;
  }
}
