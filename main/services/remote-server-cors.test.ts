// What a browser is told about other origins, through RemoteServer's real
// request handler on a real socket.
//
// Every response used to carry `Access-Control-Allow-Origin: *`, so any website
// a staff member opened on the LAN could READ the app: its state, its settings,
// and its log while no STAGE_UTILITY_LOG_TOKEN is set. The write gate never
// covered that, because it only looks at writes. These run the handler both
// listeners use, which is where the header was set and where the gate runs; a
// route test calls handleRequest, after both.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-cors-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");

const FOREIGN = "http://attacker.example";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let server: SocketServer;

const ACCESS_CONTROL = (h: http.IncomingHttpHeaders) => Object.keys(h).filter((k) => k.startsWith("access-control-")).sort();

before(async () => {
  server = await serveOnSocket(new RemoteServer().handle);
});

after(async () => {
  await server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("reads", () => {
  // Each of these answers through a different writeHead: the log through a
  // route module, the version before any of them, an unknown path from the end
  // of the dispatcher, the page from the static or control-page arm, and the
  // event stream with headers of its own. A header added at any one of them
  // shows up here; one added at a writeHead not listed would not.
  // The poll transport and the two image folders answer through writeHeads of
  // their own, none of which the paths above reach. An image that is not stored
  // answers 404 through one more.
  for (const pathname of [
    "/api/log", "/api/version", "/api/no-such-route", "/",
    "/api/events/poll?cid=x", "/layout-images/x", "/branding-images/x",
  ]) {
    test(`GET ${pathname} from another origin carries no Access-Control header`, async () => {
      const r = await server.send("GET", pathname, { headers: { Origin: FOREIGN } });
      assert.deepEqual(ACCESS_CONTROL(r.headers), [], `${pathname} told the browser another origin may read it`);
    });
  }

  // The 200 arm builds its headers apart from the 404 above, so it is read too.
  for (const dir of ["layout-images", "branding-images"] as const) {
    test(`a stored image in /${dir} carries no Access-Control header`, async () => {
      const { saveImage } = await import("./image-files.js");
      const ref = await saveImage(dir, `data:image/png;base64,${PNG_1X1}`, { checkContent: false });
      const r = await server.send("GET", ref.startsWith("/") ? ref : `/${ref}`, { headers: { Origin: FOREIGN } });
      assert.equal(r.status, 200, `${ref} was not served`);
      assert.deepEqual(ACCESS_CONTROL(r.headers), []);
    });
  }

  test("nor does the event stream", async () => {
    const r = await server.head("GET", "/api/events", { headers: { Origin: FOREIGN } });
    assert.equal(r.status, 200);
    assert.deepEqual(ACCESS_CONTROL(r.headers), []);
  });

  test("nor does a read with no Origin at all, which is what a same-origin page sends", async () => {
    const r = await server.send("GET", "/api/version");
    assert.equal(r.status, 200);
    assert.deepEqual(ACCESS_CONTROL(r.headers), []);
  });
});

describe("writes", () => {
  test("a preflight from another origin grants nothing, so the browser never sends the write", async () => {
    const r = await server.send("OPTIONS", "/api/update/apply", {
      headers: { Origin: FOREIGN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(r.status, 204);
    assert.deepEqual(ACCESS_CONTROL(r.headers), []);
  });

  test("a cross-origin write that skips the preflight is still refused", async () => {
    const r = await server.send("POST", "/api/displays/presence", { headers: { Origin: FOREIGN, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
  });

  test("a same-origin write is answered", async () => {
    const r = await server.send("POST", "/api/displays/presence", { headers: { Origin: `http://${server.host}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: false });
  });

  test("a write with no Origin (Companion, curl) is answered", async () => {
    const r = await server.send("POST", "/api/displays/presence", { headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200);
  });
});
