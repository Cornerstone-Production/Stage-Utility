// messages-routes.ts — stage messages and the messaging config.
//
// Every route must finish responding before it returns (see RouteCtx).
//
//   GET  /api/messages                   the messages:state snapshot
//   POST /api/messages                   send: { to, text, alert?, from? }
//   POST /api/messages/:id/clear-alert   end a running alert early
//   GET  /api/messaging                  groups, quick messages, quick replies
//   PUT  /api/messaging                  replace them
//
// A rule a body breaks is a 400 that says which (MessageRefused, MessagingRefused).
// Anything else that throws is a failed write and is left to the server's own
// handler, which answers 500: a send that did not save must not read as a refusal.
//
// Ids in a path are checked against the shape the server issues them in before
// anything is looked up, so what reaches the lookup is always sixteen hex digits.

import { MESSAGE_ID } from "../../types/messages.js";
import { MessageRefused, messagesService } from "../messages-service.js";
import { MessagingRefused, messagingStore } from "../messaging-store.js";
import { type RouteCtx, error, json, readBodyOrEmpty } from "./context.js";

/** A body that must be a JSON object. A JSON array is not one, and readBodyOrEmpty
 *  hands one through, so it is checked here. */
function objectBody(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export async function messagesRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

  if (method === "GET" && pathname === "/api/messages") {
    json(res, messagesService.state());
    return;
  }

  if (method === "POST" && pathname === "/api/messages") {
    // readBodyOrEmpty: a body that is not JSON reads as empty and is refused below
    // with the reason, the way every other route in this app answers one, instead
    // of reaching the server's handler as a 500.
    const body = objectBody(await readBodyOrEmpty(req));
    if (!body) {
      error(res, "body must be { to, text, alert?, from? }");
      return;
    }
    try {
      const message = await messagesService.send({ to: body.to, text: body.text, alert: body.alert, from: body.from });
      json(res, message, 201);
    } catch (err) {
      if (!(err instanceof MessageRefused)) throw err;
      error(res, err.message);
    }
    return;
  }

  const clearMatch = pathname.match(/^\/api\/messages\/([^/]+)\/clear-alert$/);
  if (method === "POST" && clearMatch) {
    const id = clearMatch[1];
    if (!MESSAGE_ID.test(id)) {
      error(res, "that is not a message id");
      return;
    }
    const body = await readBodyOrEmpty(req);
    try {
      if ((await messagesService.clearAlert(id, body.from)) === "not-found") {
        error(res, "no message has that id", 404);
        return;
      }
    } catch (err) {
      if (!(err instanceof MessageRefused)) throw err;
      error(res, err.message);
      return;
    }
    json(res, messagesService.state());
    return;
  }

  if (method === "GET" && pathname === "/api/messaging") {
    await messagingStore.init();
    json(res, messagingStore.get());
    return;
  }

  if (method === "PUT" && pathname === "/api/messaging") {
    try {
      json(res, await messagesService.updateConfig(await readBodyOrEmpty(req)));
    } catch (err) {
      if (!(err instanceof MessagingRefused)) throw err;
      error(res, err.message);
    }
    return;
  }
}
