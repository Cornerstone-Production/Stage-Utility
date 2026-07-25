// context.ts — the shared surface every route module is written against.
//
// remote-server.ts owns the listener, the SSE hub and the static-file path; each
// domain's routes live in a sibling module here and are handed this context. The
// helpers below moved out of remote-server.ts unchanged so nothing imports the
// server back (route modules stay a leaf of the dependency graph).

import * as http from "http";

import type { DisplayKind } from "../../types/stage.js";

/** Everything a route handler needs about the request in flight. */
export interface RouteCtx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** Path only — query lives on `url`. */
  pathname: string;
  url: URL;
  /** Upper-case HTTP method, defaulted to GET by the caller. */
  method: string;
}

/**
 * A domain's route table.
 *
 * A handler returns once it has responded; the dispatcher uses `res.headersSent`
 * to decide whether the request is finished, so a module that matches nothing
 * simply falls through to the next one. That is the same contract the routes had
 * as one long if-chain — a bare `return` still means "handled, stop" — which is
 * why the bodies did not have to change when they moved out here.
 */
export type RouteModule = (c: RouteCtx) => Promise<void>;

export function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

export async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Narrow an untrusted body value to a DisplayKind. */
export function isDisplayKind(v: unknown): v is DisplayKind {
  return (
    v === "slots" ||
    v === "dashboard" ||
    v === "stage" ||
    v === "transcription" ||
    v === "custom" ||
    v === "script" ||
    v === "spl-rundown"
  );
}
