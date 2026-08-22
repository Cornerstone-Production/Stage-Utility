// route-harness.ts — drive a route module without a socket.
//
// Route handlers take a RouteCtx and write to a ServerResponse. Both are plain
// objects to the handler, so a test can hand it fakes and read back exactly what
// a client would have received — no listening port, no HTTP round trip, no test
// framework.
//
// This exists because the route modules are the least-covered code in the
// project and the only LAN-facing surface. The prototype-pollution bug reached
// the slots store through POST /api/slots, and a test at this level is the one
// that would have caught it.

import type * as http from "node:http";
import { Readable } from "node:stream";

import type { RouteCtx } from "./context.js";

/** What a handler wrote back. */
export interface Captured {
  /** Status code, or null when the handler never responded. */
  status: number | null;
  headers: Record<string, string>;
  /** Raw body as written. */
  body: string;
  /** Body parsed as JSON, or null when it was not JSON. */
  json: unknown;
  /** Raw bytes, when the handler ended with a Buffer (a served asset). */
  bytes?: Buffer;
  /** True once writeHead or end has run — the dispatcher's "handled" signal. */
  responded: boolean;
}

/** A ServerResponse stand-in that records instead of writing to a socket. */
function fakeResponse(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {
    status: null,
    headers: {},
    body: "",
    json: null,
    responded: false,
  };

  const res = {
    // The dispatcher decides "was this handled?" from headersSent, so the fake
    // has to model it or every test would report a handler as falling through.
    get headersSent() {
      return captured.responded;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      Object.assign(captured.headers, headers ?? {});
      captured.responded = true;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    write(chunk: unknown) {
      captured.body += String(chunk);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        // Buffers are kept as bytes as well as stringified: a route serving a
        // binary asset would otherwise be untestable, because String(buffer)
        // mangles anything that is not UTF-8.
        if (Buffer.isBuffer(chunk)) captured.bytes = chunk;
        captured.body += String(chunk);
      }
      captured.responded = true;
      try {
        captured.json = captured.body ? JSON.parse(captured.body) : null;
      } catch {
        captured.json = null;
      }
      return res;
    },
  } as unknown as http.ServerResponse;

  return { res, captured };
}

export interface RequestOptions {
  method?: string;
  /** Sent as a JSON body. Mutually exclusive with `raw`. */
  body?: unknown;
  /** Sent verbatim — for malformed-JSON cases. */
  raw?: string;
  /** Sent verbatim as bytes — for upload routes, which read the request as a
   *  stream rather than parsing it. */
  rawBytes?: Buffer;
  headers?: Record<string, string>;
}

/**
 * Run `route` against one request and return what it wrote.
 *
 * `path` may carry a query string; it is split the way the dispatcher splits it.
 */
export async function callRoute(
  route: (c: RouteCtx) => Promise<void>,
  path: string,
  opts: RequestOptions = {},
): Promise<Captured> {
  const { res, captured } = fakeResponse();
  const url = new URL(path, "http://localhost:8788");

  const payload =
    opts.rawBytes ?? opts.raw ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
  // readBody consumes the request as a stream, so the fake has to be one.
  const req = Readable.from(
    payload.length ? [Buffer.isBuffer(payload) ? payload : Buffer.from(payload)] : [],
  ) as unknown as http.IncomingMessage;
  req.method = opts.method ?? "GET";
  req.url = path;
  req.headers = opts.headers ?? {};

  await route({
    req,
    res,
    pathname: url.pathname,
    url,
    method: (opts.method ?? "GET").toUpperCase(),
  });

  return captured;
}
