// DNS rebinding, through RemoteServer's real request handler on a real socket.
//
// A rebinding page reaches this server under the attacker's own hostname, so to
// the browser it is same-origin: its reads carry no Origin and its writes carry
// an Origin that matches Host, and the write gate passes both. The only thing
// that differs from the app's own pages is the name in Host. These send exactly
// what such a page sends, by name, and check what it gets back.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-host-check-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");
const { hostNames, hostNamesConfigStore, hostNamesSeenStore } = await import("./host-names.js");

const REBIND = "rebind-7f3a.attacker.example";
let server: SocketServer;
const realWarn = console.warn;
const realLog = console.log;

/** What the attacker's page sends: its own name in Host, and on a write, an Origin to match. */
const asRebind = (extra: Record<string, string> = {}) => ({ headers: { Host: `${REBIND}:${server.port}`, ...extra } });

before(async () => {
  console.warn = () => {};
  console.log = () => {};
  server = await serveOnSocket(new RemoteServer().handle);
});

beforeEach(async () => {
  await hostNames.stop();
  await hostNamesConfigStore.save({ accepted: [], dismissed: [] });
  await hostNamesSeenStore.save({ names: [] });
  await hostNames.init();
});

after(async () => {
  await hostNames.stop();
  await server.close();
  console.warn = realWarn;
  console.log = realLog;
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("refusal off, the default", () => {
  test("a page reached by its own name cannot put that name on the list for later", async () => {
    for (const body of [{ add: REBIND }, { accept: REBIND }, { enforce: true }]) {
      const r = await server.send("POST", "/api/security/host-names", {
        ...asRebind({ Origin: `http://${REBIND}:${server.port}`, "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.deepEqual(hostNames.view().accepted, []);
    assert.equal(hostNames.enforcing, false);
  });

  test("a stream opened by an unlisted name is closed when refusal turns on; one by IP stays", async () => {
    const http = await import("node:http");
    const open = (host: string) =>
      new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const r = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events", headers: { Host: host } }, resolve);
        r.on("error", reject);
      });
    const rebound = await open(`${REBIND}:${server.port}`);
    const own = await open(server.host);
    const ended = (res: import("node:http").IncomingMessage) =>
      new Promise<boolean>((resolve) => {
        res.on("close", () => resolve(true));
        res.resume();
        setTimeout(() => resolve(false), 500);
      });
    const [reboundEnded, ownEnded] = await Promise.all([ended(rebound), ended(own), hostNames.setEnforce(true)]);
    assert.equal(reboundEnded, true, "the rebinding stream is still open");
    assert.equal(ownEnded, false, "the stream opened by IP was closed");
    own.destroy();
  });

  test("a rebinding read is answered, and its name waits on the card", async () => {
    const r = await server.send("GET", "/api/version", asRebind());
    assert.equal(r.status, 200);
    const view = JSON.parse((await server.send("GET", "/api/security/host-names")).body);
    assert.deepEqual(
      view.waiting.map((w: { name: string }) => w.name),
      [REBIND],
    );
  });
});

describe("refusal on", () => {
  beforeEach(() => hostNames.setEnforce(true));

  test("a rebinding read gets a 403 that names the way back", async () => {
    const r = await server.send("GET", "/api/version", asRebind());
    assert.equal(r.status, 403);
    assert.match(r.body, new RegExp(`does not answer to the name ${REBIND.replace(/\./g, "\\.")}`));
    assert.ok(!r.body.includes('"version"'), "the refusal carried the answer");
  });

  test("a browser opening a page by that name gets the same sentence as a page", async () => {
    const r = await server.send("GET", "/", asRebind({ Accept: "text/html" }));
    assert.equal(r.status, 403);
    assert.match(r.headers["content-type"] ?? "", /text\/html/);
    assert.match(r.body, /Settings, Advanced, Host names/);
  });

  test("a rebinding write cannot turn refusal off, nor put its own name on the list", async () => {
    const origin = { Origin: `http://${REBIND}:${server.port}`, "Content-Type": "application/json" };
    for (const body of [{ enforce: false }, { add: REBIND }]) {
      const r = await server.send("POST", "/api/security/host-names", { ...asRebind(origin), body: JSON.stringify(body) });
      assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.equal(hostNames.enforcing, true);
    assert.equal((await server.send("GET", "/api/version", asRebind())).status, 403);
  });

  test("the event stream is refused too, before it opens", async () => {
    const r = await server.head("GET", "/api/events", asRebind());
    assert.equal(r.status, 403);
  });

  for (const host of ["127.0.0.1", "stage-display", "stage-utility.local"]) {
    test(`a request by ${host} is answered`, async () => {
      const r = await server.send("GET", "/api/version", { headers: { Host: `${host}:${server.port}` } });
      assert.equal(r.status, 200);
    });
  }

  test("a name added from the card, by IP, is answered from then on", async () => {
    const add = await server.send("POST", "/api/security/host-names", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ add: "https://Stage.Example.org/display-1" }),
    });
    assert.equal(add.status, 200);
    assert.equal((await server.send("GET", "/api/version", { headers: { Host: "stage.example.org" } })).status, 200);
  });
});

describe("the route", () => {
  test("refuses what cannot go on the list, with the card's sentence", async () => {
    const r = await server.send("POST", "/api/security/host-names", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ add: "10.0.0.5" }),
    });
    assert.equal(r.status, 400);
    assert.match(r.body, /IP addresses are always answered/);
  });

  test("refuses a body that asks for nothing", async () => {
    const r = await server.send("POST", "/api/security/host-names", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enforce: "yes" }),
    });
    assert.equal(r.status, 400);
  });
});
