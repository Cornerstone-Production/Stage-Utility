// host-name-routes.ts — the names this server answers to (Settings, Advanced).
//
//   GET  /api/security/host-names   the list, the names waiting, the switch
//   POST /api/security/host-names   one change: {enforce} | {add} | {accept} |
//                                   {remove} | {dismiss} | {undismiss}
//
// A write like every other setting, and the cross-origin gate applies. It also
// has to arrive by a name answered without the list: otherwise a page reaching
// the server by its own name while refusal is off could list that name, and be
// answered once refusal is on.

import { hostNames } from "../host-names.js";
import { type RouteCtx, error, json, readBodyOrEmpty } from "./context.js";

const PATH = "/api/security/host-names";

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function hostNameRoutes({ req, res, pathname, method }: RouteCtx): Promise<void> {
  if (pathname !== PATH) return;
  if (method === "GET") {
    json(res, hostNames.view());
    return;
  }
  if (method !== "POST") return;

  if (!hostNames.answersTo(req.headers.host)) {
    error(res, "Change the host names from the server's IP address, or a name already on the list.", 403);
    return;
  }
  const body = await readBodyOrEmpty(req);
  const add = text(body.add);
  const accept = text(body.accept);
  const remove = text(body.remove);
  const dismiss = text(body.dismiss);
  const undismiss = text(body.undismiss);

  let result: { ok: true } | { ok: false; error: string } = { ok: true };
  if (typeof body.enforce === "boolean") await hostNames.setEnforce(body.enforce);
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
