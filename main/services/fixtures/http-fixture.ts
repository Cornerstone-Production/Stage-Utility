// http-fixture.ts — the shell every test-side HTTP server shares: listen on
// 127.0.0.1:0, hand the handler the whole request body, and close without
// waiting out keep-alive or held-open sockets.
//
// A fixture keeps its own per-request state machine (fake-cloudflare's accounts,
// publish-receiver's scripted answers); only this shell is shared. A server that
// reads a request body incrementally while it streams a response (the
// ProPresenter stub) is not this shape and stays hand-built.

import http from "node:http";

export interface HttpFixture {
  port: number;
  origin: string;
  /** Drops every open socket first, so a held-open response cannot hang the close. */
  close(): Promise<void>;
}

/** Collect a request's body. Rejects if the request errors or is aborted. */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted before its body ended")));
  });
}

/** Listen on a free loopback port; `handler` runs once the body has arrived. */
export async function startHttpFixture(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<HttpFixture> {
  const server = http.createServer((req, res) => {
    readBody(req).then(
      (body) => handler(req, res, body),
      () => res.destroy(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close(): Promise<void> {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
