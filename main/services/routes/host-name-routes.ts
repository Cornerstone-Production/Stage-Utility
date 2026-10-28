// host-name-routes.ts — the names this server answers to (Settings, Advanced).
//
//   GET  /api/security/host-names   the list, the names waiting, the switch
//   POST /api/security/host-names   one change: {enforce: false} | {enforce: true,
//                                   names: [...]} | {add} | {accept} | {remove} |
//                                   {dismiss} | {undismiss}
//
// Turning refusal on takes the names to keep, as the operator confirmed them on
// the card; the list becomes exactly those names.
//
// A write like every other setting, and the cross-origin gate applies. It also
// has to arrive by a name answered without the list: otherwise a page reaching
// the server by its own name while refusal is off could list that name, and be
// answered once refusal is on.

import type * as http from "http";

import { hostNames } from "../host-names.js";
import { hostnameOf } from "../http-origin.js";
import { type RouteCtx, error, json, readBodyOrEmpty } from "./context.js";

const PATH = "/api/security/host-names";

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Answers 403 and returns true when the request arrived by a name the server does
 * not already answer. Every route that can change what the server answers to (the
 * list itself, the Public address, a restored config bundle) starts with this, so
 * a page reaching the server by its own name cannot list that name for later.
 */
export function refuseUnansweredHost(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (hostNames.answersTo(req.headers.host)) return false;
  error(res, "This changes which names the server answers to: make it from the server's IP address, or a name already on the list.", 403);
  return true;
}

export async function hostNameRoutes({ req, res, pathname, method }: RouteCtx): Promise<void> {
  if (pathname !== PATH) return;
  if (method === "GET") {
    json(res, hostNames.view());
    return;
  }
  if (method !== "POST") return;

  if (refuseUnansweredHost(req, res)) return;
  const body = await readBodyOrEmpty(req);
  const add = text(body.add);
  const accept = text(body.accept);
  const remove = text(body.remove);
  const dismiss = text(body.dismiss);
  const undismiss = text(body.undismiss);

  let result: { ok: true } | { ok: false; error: string } = { ok: true };
  if (body.enforce === false) await hostNames.turnRefusalOff();
  else if (body.enforce === true) {
    const names = body.names;
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
      result = { ok: false, error: "Turning refusal on needs `names`: the names to keep on the list." };
    } else {
      result = await hostNames.turnRefusalOn(names as string[], hostnameOf(req.headers.host));
    }
  }
  else if (add !== null) result = await hostNames.add(add, "added");
  else if (accept !== null) result = await hostNames.add(accept, "accepted");
  else if (remove !== null) await hostNames.remove(remove);
  else if (dismiss !== null) result = await hostNames.dismiss(dismiss);
  else if (undismiss !== null) await hostNames.undismiss(undismiss);
  else result = { ok: false, error: "Send one of enforce, add, accept, remove, dismiss or undismiss." };

  if (!result.ok) {
    error(res, result.error, 400);
    return;
  }
  json(res, hostNames.view());
}
