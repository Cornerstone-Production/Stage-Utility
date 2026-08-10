// context.ts — the shared surface every route module is written against.
//
// remote-server.ts owns the listener, the SSE hub and the static-file path; each
// domain's routes live in a sibling module here and are handed this context. The
// helpers below moved out of remote-server.ts unchanged so nothing imports the
// server back (route modules stay a leaf of the dependency graph).

import * as http from "http";

import type { ViewKind } from "../../types/stage.js";

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
 * as one long if-chain — a bare `return` still means "handled, stop".
 *
 * ⚠️ THE ONE RULE: a route MUST finish responding before it returns. `await` the
 * upstream call; never fire a callback-style request and return, expecting the
 * callback to reply later.
 *
 * Why it matters: on return the dispatcher checks `res.headersSent`. A route that
 * has not replied yet looks unhandled, so the dispatcher continues, the 404 arm
 * ends the response, and the late `res.writeHead()` throws ERR_HTTP_HEADERS_SENT
 * from an event callback — which is unhandled and TAKES THE PROCESS DOWN, blanking
 * every display. The ProPresenter thumbnail proxy did exactly this; it now awaits
 * (see fetchThumbnail in proxy-routes.ts).
 */
export type RouteModule = (c: RouteCtx) => Promise<void>;

export function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

/**
 * Ceilings on an incoming request body.
 *
 * Neither reader had one. The app has no auth by design — it is LAN-trusted —
 * and a POST sent by curl carries no Origin, so the cross-origin write gate does
 * not apply to it either. `curl -X POST --data-binary @big.bin` therefore
 * accumulated without bound until the heap died, taking every stage display with
 * it and losing whatever the recorders had not yet flushed. Two limits because
 * the two bodies are nothing alike: JSON here is config, an upload is a zip or an
 * image.
 */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = 512 * 1024 * 1024;

/** Thrown past the route handlers so remote-server can answer 413. */
export class BodyTooLargeError extends Error {
  readonly status = 413;
  constructor(limit: number) {
    super(`Request body exceeds ${Math.round(limit / (1024 * 1024))} MB`);
    this.name = "BodyTooLargeError";
  }
}

/** Refuse early when the sender declares a size over the limit. */
function refuseDeclared(req: http.IncomingMessage, limit: number): void {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);
}

/** The request body as bytes. `readBody` parses JSON and would mangle a binary
 *  upload, so anything carrying a file uses this instead. */
export async function readRawBody(
  req: http.IncomingMessage,
  limit = MAX_UPLOAD_BODY_BYTES,
): Promise<Uint8Array> {
  refuseDeclared(req, limit);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    // Checked as it arrives, not just against the header: content-length is the
    // sender's claim and a chunked request does not send one at all.
    if (total > limit) {
      req.destroy();
      throw new BodyTooLargeError(limit);
    }
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

export async function readBody(
  req: http.IncomingMessage,
  limit = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  refuseDeclared(req, limit);
  return new Promise((resolve, reject) => {
    let body = "";
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limit) {
        req.destroy();
        reject(new BodyTooLargeError(limit));
        return;
      }
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

/** Narrow an untrusted body value to a ViewKind. */
export function isDisplayKind(v: unknown): v is ViewKind {
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
