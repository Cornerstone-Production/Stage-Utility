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
import { cleanUrlsMiddleware } from "./dev-clean-urls.js";

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

interface Reply {
  status: number;
  location: string | undefined;
  cacheControl: string | undefined;
  body: string;
}

/** The request line goes out exactly as given, and a redirect is read, not followed. */
function request(method: string, rawPath: string, atPort: number = port): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: atPort, path: rawPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
          cacheControl: res.headers["cache-control"],
          body: Buffer.concat(chunks).toString("utf8"),
        }),
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
    const r = await request("GET", "/scriptview/youth%20night/full?plan=77");
    assert.equal(r.location, "/servicecue/youth%20night/full?plan=77");
  });

  test("is never cached: a browser that followed it must ask again next time", async () => {
    // A bare 301 is cached indefinitely. A kiosk that followed one and is later
    // pointed at a build with no /servicecue would be sent to a page that is gone.
    for (const [method, p] of [["GET", "/scriptview/weekend/audio?text=150"], ["HEAD", "/scriptview"]] as const) {
      const r = await request(method, p);
      assert.equal(r.status, 301);
      assert.equal(r.cacheControl, "no-store", `${method} ${p} is cacheable`);
    }
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

// The Vite dev server answers the same addresses through cleanUrlsMiddleware. The
// config file itself cannot be loaded outside Vite (it reads __dirname), so what
// is driven here is the middleware it installs, on a real HTTP server; the one
// line in vite.config.ts that installs it is not covered by a test.
describe("the dev server's middleware gives the same answer", () => {
  let dev: http.Server;
  let devPort = 0;
  before(async () => {
    dev = http.createServer((req, res) => {
      cleanUrlsMiddleware(req, res, () => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`next:${req.url}`);
      });
    });
    await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
    devPort = (dev.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => dev.close(() => r())));

  test("a /scriptview address is a 301 to /servicecue, query kept, and never cached", async () => {
    const r = await request("GET", "/scriptview/weekend/audio?text=150&plan=1", devPort);
    assert.equal(r.status, 301);
    assert.equal(r.location, "/servicecue/weekend/audio?text=150&plan=1");
    assert.equal(r.cacheControl, "no-store");
  });

  test("the new address and the displays are routed to their documents, not redirected", async () => {
    assert.equal((await request("GET", "/servicecue/weekend/audio?text=150", devPort)).body, "next:/app.html");
    assert.equal((await request("GET", "/display-1", devPort)).body, "next:/index.html");
  });

  test("a POST to the old address is not redirected", async () => {
    assert.equal((await request("POST", "/scriptview", devPort)).status, 200);
  });
});
