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
/**
 * Upload ceiling, sized for the hardware rather than for the format.
 *
 * readRawBody holds the chunk list, then Buffer.concat allocates a second full
 * copy — so the peak is roughly twice the body. 512 MB was above what a
 * Raspberry Pi survives, which left the unauthenticated OOM this cap exists to
 * prevent still one curl away; the number just had to be reached. 128 MB is
 * comfortably larger than any real archive this app produces and safe to hold
 * twice on the smallest supported box. A bundle genuinely bigger than this wants
 * streaming to a temp file, not a bigger number.
 */
export const MAX_UPLOAD_BODY_BYTES = 128 * 1024 * 1024;

/**
 * JSON ceilings for the two routes that legitimately carry a payload.
 *
 * The 8 MB default is the right size for config POSTs and wrong for these: the
 * app's own image limit is 12 MB, base64 adds about a third, and a config
 * snapshot embeds every stored image at once. So the app could export a backup
 * it then refused to import, and reject an image the image store would have
 * accepted — a 413 from a limit nobody had lined up against the limit beside it.
 *
 * Raised here per route rather than globally: the small default is what keeps an
 * unauthenticated LAN POST from growing without bound, and these two are the
 * only routes with a reason to be bigger. `bodyLimits.test.ts` fails if either
 * of these ever drops below what the image store accepts, which is the drift
 * that caused this.
 */
export const MAX_IMAGE_BODY_BYTES = 24 * 1024 * 1024;
/** A snapshot carries every config file AND every uploaded image, base64'd. Big
 *  enough for a real install's worth; a bundle past this wants streaming to a
 *  temp file rather than a larger number held twice in memory on a Pi. */
export const MAX_CONFIG_BODY_BYTES = 64 * 1024 * 1024;

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
      // Pause, do NOT destroy. Destroying the request tears down the socket, and
      // the 413 written afterwards is silently dropped — the caller saw
      // ECONNRESET on exactly the path this streaming check exists for.
      req.pause();
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
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limit) {
        // Pause rather than destroy — see readRawBody.
        req.pause();
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        // Decoded once, at the end. Decoding each chunk as it arrived split any
        // multi-byte character that straddled a chunk boundary into two halves,
        // each of which decodes to U+FFFD — so a curly apostrophe in a song
        // title or an accent in a name came back as replacement characters,
        // depending only on where TCP happened to cut the stream.
        const body = Buffer.concat(chunks, total).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Read a JSON body, tolerating junk but NOT an oversized one.
 *
 * Replaces `readBody(req).catch(() => ({}))`, which was written to shrug off an
 * unparseable body and also swallowed the size limit — so an over-cap request
 * proceeded with an empty body and answered 200, and the 413 never reached
 * anyone. A body too large to read is a different thing from a body we chose not
 * to parse.
 */
export async function readBodyOrEmpty(
  req: http.IncomingMessage,
  limit = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  try {
    return ((await readBody(req, limit)) ?? {}) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    return {};
  }
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
    v === "spl-rundown" ||
    v === "signage"
  );
}
