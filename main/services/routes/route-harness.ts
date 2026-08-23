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
import { Readable, Writable } from "node:stream";

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

/**
 * A ServerResponse stand-in that records instead of writing to a socket.
 *
 * A real Writable, not an object with a `write` method. Routes that serve a file
 * PIPE it — the media route does, so a 200 MB video is never held in memory —
 * and pipe() needs a genuine stream at the far end: `on`, `once`, backpressure,
 * `destroy`. A hand-rolled fake made those three tests fail while the route
 * itself was correct, which is the wrong way round for a harness whose whole
 * purpose is to exercise the real path.
 */
class FakeResponse extends Writable {
  readonly captured: Captured = {
    status: null,
    headers: {},
    body: "",
    json: null,
    responded: false,
  };

  private chunks: Buffer[] = [];

  // The dispatcher decides "was this handled?" from headersSent, so the fake
  // has to model it or every test would report a handler as falling through.
  get headersSent(): boolean {
    return this.captured.responded;
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.captured.status = status;
    Object.assign(this.captured.headers, headers ?? {});
    this.captured.responded = true;
    return this;
  }

  setHeader(name: string, value: string): this {
    this.captured.headers[name] = value;
    return this;
  }

  override _write(chunk: Buffer | string, _enc: unknown, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    cb();
  }

  /** Fold what was written into the shape tests read. */
  settle(): void {
    this.captured.responded = this.captured.responded || this.chunks.length > 0;
    const all = Buffer.concat(this.chunks);
    // Bytes are kept as well as text: a route serving a binary asset would
    // otherwise be untestable, because String(buffer) mangles anything that is
    // not UTF-8.
    if (all.length) this.captured.bytes = all;
    this.captured.body = all.toString();
    try {
      this.captured.json = this.captured.body ? JSON.parse(this.captured.body) : null;
    } catch {
      this.captured.json = null;
    }
  }
}

function fakeResponse(): { res: http.ServerResponse; captured: Captured; settle: () => Promise<void> } {
  const fake = new FakeResponse();
  const res = fake as unknown as http.ServerResponse;

  // Resolves when the response is finished OR destroyed. Destroyed counts: a
  // route that gives up mid-stream (a file that vanished under it) destroys the
  // response deliberately, and a harness that hung there would turn a handled
  // failure into a test timeout.
  const done = new Promise<void>((resolve) => {
    fake.once("finish", resolve);
    fake.once("close", resolve);
    fake.once("error", () => resolve());
  });

  return {
    res,
    captured: fake.captured,
    settle: async () => {
      // Only wait on a response that was actually started. A handler that fell
      // through never ends the stream, and awaiting it would hang the suite.
      if (fake.captured.responded || fake.writableEnded) await done;
      fake.settle();
    },
  };
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
  const { res, captured, settle } = fakeResponse();
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

  // A piped response is still arriving when the handler returns — it hands the
  // stream over and gets out of the way. Waiting here is what lets a test read
  // the bytes of a served file.
  await settle();
  return captured;
}
