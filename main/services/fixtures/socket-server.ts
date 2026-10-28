// socket-server.ts — a request handler served on a real loopback socket, for a
// test that is about what a client receives.
//
// Headers are the reason. Node merges what a handler set with setHeader() into
// whatever it later passes to writeHead(), so the headers on the wire are not the
// ones either call shows on its own, and a fake response cannot say what a
// browser was told. route-harness.ts drives a route module without a socket;
// this serves RemoteServer's whole handler.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: string;
}

export interface SocketServer {
  port: number;
  /** `127.0.0.1:<port>`, as a browser's Host header carries it. */
  host: string;
  /** One request with exactly these headers, read to the end. Not fetch: undici
   *  decides Host and Origin for itself, and these tests are about those two. */
  send(method: string, pathname: string, opts?: RequestOptions): Promise<Answer>;
  /** The status and headers alone, then the connection is dropped: for a
   *  response that never ends, such as the event stream. */
  head(method: string, pathname: string, opts?: RequestOptions): Promise<Omit<Answer, "body">>;
  close(): Promise<void>;
}

export async function serveOnSocket(handle: http.RequestListener): Promise<SocketServer> {
  const server = http.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  function request(method: string, pathname: string, opts: RequestOptions, onResponse: (res: http.IncomingMessage, req: http.ClientRequest) => void, reject: (err: Error) => void): void {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: opts.headers }, (res) => onResponse(res, req));
    // A server that refuses an oversized body answers before reading it all and
    // closes, so the rest of the write fails. The answer still arrives.
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE" && err.code !== "ECONNRESET") reject(err);
    });
    req.end(opts.body);
  }

  return {
    port,
    host: `127.0.0.1:${port}`,
    send: (method, pathname, opts = {}) =>
      new Promise((resolve, reject) =>
        request(method, pathname, opts, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        }, reject),
      ),
    head: (method, pathname, opts = {}) =>
      new Promise((resolve, reject) =>
        request(method, pathname, opts, (res, req) => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers });
          req.destroy();
        }, reject),
      ),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
