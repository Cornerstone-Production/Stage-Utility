// messages-routes.ts — stage messages and the messaging config.
//
// Every route must finish responding before it returns (see RouteCtx).
//
//   GET  /api/messages                   the messages:state snapshot
//   POST /api/messages                   send: { to, text, alert?, from? }
//   POST /api/messages/:id/clear-alert   end a running alert early
//   GET  /api/messaging                  groups, quick messages, quick replies
//   PUT  /api/messaging                  replace them; carries the `version` it was
//                                        built from
//
// A rule a body breaks is a 400 that says which (MessageRefused). A PUT built from
// a config another window has since replaced is a 409 and changes nothing
// (MessagingConflict). A PUT that saved but could not take a deleted group off the
// screens is a 500 with code `groups-not-cleared` (GroupsNotCleared): saving again
// retries it. Anything else that throws is a failed write and is left to the
// server's own handler, which answers 500: a send that did not save must not read
// as a refusal. All of that is answerFailure, so each route has one catch.
//
// Ids in a path are checked against the shape the server issues them in before
// anything is looked up, so what reaches the lookup is always sixteen hex digits.

import { MESSAGE_ID } from "../../types/messages.js";
import { MessageRefused } from "../message-rules.js";
import { GroupsNotCleared, messagesService } from "../messages-service.js";
import { MessagingConflict } from "../messaging-store.js";
import { type RouteCtx, error, json, readBodyOrEmpty } from "./context.js";
import type http from "node:http";

/** A body that must be a JSON object. A JSON array is not one, and readBodyOrEmpty
 *  hands one through, so it is checked here. */
function objectBody(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** Answer a failure the caller can act on, or rethrow one they cannot. */
function answerFailure(res: http.ServerResponse, err: unknown): void {
  if (err instanceof MessagingConflict) {
    console.warn("[messages] refused a save of the groups and quick messages built from an older version of the config");
    error(res, err.message, 409, "config-changed");
  } else if (err instanceof GroupsNotCleared) {
    // Saved, but the screens still hold a group that is gone. 500 with the message
    // and a code, so the page can tell it from a save that did not happen: the
    // config it holds is out of date either way.
    error(res, err.message, 500, "groups-not-cleared");
  } else if (err instanceof MessageRefused) {
    error(res, err.message);
  } else {
    throw err;
  }
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
      answerFailure(res, err);
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
      } else {
        json(res, messagesService.state());
      }
    } catch (err) {
      answerFailure(res, err);
    }
    return;
  }

  if (method === "GET" && pathname === "/api/messaging") {
    json(res, await messagesService.config());
    return;
  }

  if (method === "PUT" && pathname === "/api/messaging") {
    try {
      json(res, await messagesService.updateConfig(await readBodyOrEmpty(req)));
    } catch (err) {
      answerFailure(res, err);
    }
    return;
  }
}
