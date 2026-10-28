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
const { configSnapshot } = await import("./config-snapshot.js");
const { stageController } = await import("./stage-controller.js");
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
    const [reboundEnded, ownEnded] = await Promise.all([ended(rebound), ended(own), hostNames.turnRefusalOn([])]);
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
  beforeEach(() => hostNames.turnRefusalOn([]));

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
    // A screen left on this page must come back once the operator lists its name.
    assert.match(r.body, /<meta http-equiv="refresh" content="30">/);
  });

  test("the JSON refusal does not carry a reload", async () => {
    const r = await server.send("GET", "/api/version", asRebind());
    assert.doesNotMatch(r.body, /refresh/);
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

describe("turning refusal on through the route", () => {
  const json = { "Content-Type": "application/json" };
  const post = (body: unknown, host?: string) =>
    server.send("POST", "/api/security/host-names", { headers: { ...json, ...(host ? { Host: `${host}:${server.port}` } : {}) }, body: JSON.stringify(body) });

  test("without the names to keep it is refused and refusal stays off", async () => {
    const r = await post({ enforce: true });
    assert.equal(r.status, 400);
    assert.match(r.body, /needs `names`/);
    assert.equal(hostNames.enforcing, false);
  });

  test("the list becomes exactly the names sent; one not sent is refused afterwards", async () => {
    for (const host of ["ha.example.org", "tablet.example.org"]) await server.send("GET", "/api/version", { headers: { Host: `${host}:${server.port}` } });
    const r = await post({ enforce: true, names: ["ha.example.org"] });
    assert.equal(r.status, 200);
    assert.equal((await server.send("GET", "/api/version", { headers: { Host: "ha.example.org" } })).status, 200);
    assert.equal((await server.send("GET", "/api/version", { headers: { Host: "tablet.example.org" } })).status, 403);
  });

  test("a name that never reached the server cannot be kept", async () => {
    const r = await post({ enforce: true, names: ["invented.example.org"] });
    assert.equal(r.status, 400);
    assert.equal(hostNames.enforcing, false);
  });

  test("from a listed name, leaving that name out is refused: the operator would be locked out", async () => {
    await post({ add: "stage.example.org" });
    const r = await post({ enforce: true, names: [] }, "stage.example.org");
    assert.equal(r.status, 400);
    assert.match(r.body, /lock you out/);
    assert.equal(hostNames.enforcing, false);
    assert.equal((await post({ enforce: true, names: ["stage.example.org"] }, "stage.example.org")).status, 200);
  });

  test("turning it on again while it is on is a 400 with a sentence", async () => {
    assert.equal((await post({ enforce: true, names: [] })).status, 200);
    const r = await post({ enforce: true, names: [] });
    assert.equal(r.status, 400);
    assert.match(r.body, /Refusal is already on/);
  });

  test("always-answered names in the list are ignored, not a 400", async () => {
    await server.send("GET", "/api/version", { headers: { Host: `ha.example.org:${server.port}` } });
    const r = await post({ enforce: true, names: ["10.0.0.5", "stage-display", "panel.local", "ha.example.org"] });
    assert.equal(r.status, 200);
    assert.deepEqual(hostNames.view().accepted.map((a) => a.name), ["ha.example.org"]);
  });

  test("a rebinding page cannot turn it on with a list of its own", async () => {
    const r = await server.send("POST", "/api/security/host-names", {
      ...asRebind({ Origin: `http://${REBIND}:${server.port}`, ...json }),
      body: JSON.stringify({ enforce: true, names: [REBIND] }),
    });
    assert.equal(r.status, 403);
    assert.equal(hostNames.enforcing, false);
  });
});

// The list also grows through anything that sets a name the server answers: the
// Public address, and a restored config bundle (host-names.json and settings.json).
// Each starts with the same gate as the card's own route.
describe("the other routes that can put a name on the answered list", () => {
  const json = { "Content-Type": "application/json" };

  test("the Public address cannot be set under a name that is not answered", async () => {
    const before = stageController.getState().publicUrl ?? null;
    const r = await server.send("POST", "/api/public-url", {
      ...asRebind({ Origin: `http://${REBIND}:${server.port}`, ...json }),
      body: JSON.stringify({ url: `https://${REBIND}` }),
    });
    assert.equal(r.status, 403);
    assert.equal(stageController.getState().publicUrl ?? null, before);
    assert.equal(hostNames.answersTo(REBIND), false, "the name became an answered name");
  });

  test("the Public address can be set by the server's IP", async () => {
    const r = await server.send("POST", "/api/public-url", {
      headers: json,
      body: JSON.stringify({ url: "https://stage.example.org" }),
    });
    assert.equal(r.status, 200);
    await server.send("POST", "/api/public-url", { headers: json, body: JSON.stringify({ url: null }) });
  });

  for (const [label, path, patch] of [
    ["a config import", "/api/config/import", "apply"],
    ["a snapshot recall", "/api/config/snapshots/some-id/recall", "recall"],
  ] as const) {
    test(`${label} is refused under a name that is not answered, and applies nothing`, async () => {
      const real = configSnapshot[patch];
      let reached = 0;
      (configSnapshot as unknown as Record<string, unknown>)[patch] = async () => {
        reached++;
        throw new Error("stubbed");
      };
      try {
        const r = await server.send("POST", path, {
          ...asRebind({ Origin: `http://${REBIND}:${server.port}`, ...json }),
          body: JSON.stringify({ bundle: { "host-names.json": { accepted: [REBIND] } } }),
        });
        assert.equal(r.status, 403);
        assert.equal(reached, 0, "the bundle reached configSnapshot");

        const own = await server.send("POST", path, { headers: json, body: JSON.stringify({ bundle: {} }) });
        assert.equal(own.status, 400, "the IP request was refused by the gate");
        assert.equal(reached, 1, "a request by IP did not reach configSnapshot");
      } finally {
        (configSnapshot as unknown as Record<string, unknown>)[patch] = real;
      }
    });
  }
});
