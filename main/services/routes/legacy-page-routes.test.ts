// The old /scriptview address answers with a permanent redirect to /servicecue.
//
// Displays and bookmarks point at the old address and keep pointing there, and a
// display's address carries state in its query (?plan=, ?text=, ?transport=poll).
// So this runs the real thing: a real HTTP server whose handler is dispatched
// from remote-server.ts's own EARLY_ROUTE_MODULES — the list production walks —
// and a real client that does not follow the redirect, so the 301 itself is what
// is read. A source scan of the module would be satisfied by a comment, and a
// test of the pure function would stay green with the module never dispatched.

import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { EARLY_ROUTE_MODULES } from "../remote-server.js";

let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      for (const routeModule of EARLY_ROUTE_MODULES) {
        await routeModule({ req, res, pathname: url.pathname, url, method: (req.method ?? "GET").toUpperCase() });
        if (res.headersSent) return;
      }
      // What production does next is serve the page. Here, a marker that no
      // early module claimed the request.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fell through");
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));

/** The request line goes out exactly as given, and a redirect is read, not followed. */
function request(method: string, rawPath: string): Promise<{ status: number; location: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("a /scriptview address redirects permanently to /servicecue", () => {
  test("the rest of the path and the whole query string survive", async () => {
    const r = await request("GET", "/scriptview/weekend/audio?text=150&plan=1");
    assert.equal(r.status, 301);
    assert.equal(r.location, "/servicecue/weekend/audio?text=150&plan=1");
  });

  test("every page that moved lands on its new twin", async () => {
    for (const [from, to] of [
      ["/scriptview", "/servicecue"],
      ["/scriptview/", "/servicecue/"],
      ["/scriptview/manage", "/servicecue/manage"],
      ["/scriptview/presets", "/servicecue/presets"],
      ["/scriptview/sunday/full", "/servicecue/sunday/full"],
    ] as const) {
      const r = await request("GET", from);
      assert.equal(r.status, 301, `${from} is not a 301`);
      assert.equal(r.location, to, `${from} went to the wrong place`);
    }
  });

  test("a polling display keeps its transport", async () => {
    const r = await request("GET", "/scriptview?transport=poll");
    assert.equal(r.location, "/servicecue?transport=poll");
  });

  test("a percent-encoded path segment is passed through untouched", async () => {
    const r = await request("GET", "/scriptview/cornerstone%20youth/full?plan=77");
    assert.equal(r.location, "/servicecue/cornerstone%20youth/full?plan=77");
  });

  test("HEAD is redirected too", async () => {
    const r = await request("HEAD", "/scriptview/weekend/audio");
    assert.equal(r.status, 301);
    assert.equal(r.location, "/servicecue/weekend/audio");
  });
});

describe("nothing else is redirected", () => {
  test("the new address, a lookalike and the API are left alone", async () => {
    for (const p of ["/servicecue/weekend/audio", "/scriptviewer", "/scriptviewx/a", "/api/scriptview/layouts", "/history"]) {
      const r = await request("GET", p);
      assert.equal(r.status, 200, `${p} must not be redirected`);
      assert.equal(r.body, "fell through", `${p} must reach the rest of the server`);
    }
  });

  test("a POST to the old address is not turned into a GET", async () => {
    const r = await request("POST", "/scriptview/weekend/audio");
    assert.equal(r.body, "fell through");
  });
});
