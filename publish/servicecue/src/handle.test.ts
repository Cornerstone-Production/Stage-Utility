// handle.test.ts — the Worker's request handler, whole, against an in-memory hub.
//
// This is the code the edge runs: routing, the token, body limits, validation,
// headers, every refusal. What it is not is the runtime: the Durable Object's storage,
// its sockets and what it sends them are shown in workerd by test/ and by
// messages.test.ts. validate.test.ts owns the tables of what a body may be, so a case
// here keeps one bad body per route, enough to show the route turns it into a 400.
// Each case that refuses something also checks nothing was stored.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { PUBLISH_MAX_BODY_BYTES, PUBLISH_MIN_TOKEN_LENGTH, viewerBuildTag } from "../../../main/types/servicecue-publish.js";
import { __resetBuildNoticesForTests } from "./build.js";
import { handle, type HandlerDeps } from "./handle.js";
import { BASE_HEADERS, SVG_CSP, htmlCsp } from "./headers.js";
import { MemoryHub } from "./memory-hub-harness.js";

/** The build id the stand-in page below is stamped with. */
const BUILD = "0123456789ab";
const TOKEN = "t".repeat(PUBLISH_MIN_TOKEN_LENGTH + 8);
const ORIGIN = "https://servicecue.example.workers.dev";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

interface Setup {
  hub: MemoryHub;
  /** Every request the handler made of the static assets, as "METHOD /path". */
  assetCalls: string[];
  /** The build id each socket handshake was handed to the object with. */
  upgrades: (string | null)[];
  run: (method: string, path: string, init?: { headers?: Record<string, string>; body?: BodyInit | null }) => Promise<Response>;
}

const FILES = new Map<string, { body: string; type: string }>([
  ["/servicecue.html", { body: `<!doctype html><title>viewer</title>${viewerBuildTag(BUILD)}`, type: "text/html; charset=utf-8" }],
]);

function setup(over: Partial<HandlerDeps> = {}): Setup {
  const hub = new MemoryHub();
  const assetCalls: string[] = [];
  const upgrades: (string | null)[] = [];
  const assets: HandlerDeps["assets"] = async (request) => {
    const path = new URL(request.url).pathname;
    assetCalls.push(`${request.method} ${path}`);
    const file = FILES.get(path);
    if (!file) return new Response("missing", { status: 404 });
    if (request.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
    return new Response(request.method === "HEAD" ? null : file.body, { headers: { "Content-Type": file.type, ETag: '"v1"' } });
  };
  const upgrade: HandlerDeps["upgrade"] = async (_request, build) => {
    upgrades.push(build);
    return new Response("upgraded", { status: 200 });
  };
  const deps: HandlerDeps = { hub, upgrade, assets, token: TOKEN, now: () => 5_000_000, ...over };
  return {
    hub,
    assetCalls,
    upgrades,
    run: (method, path, init = {}) =>
      handle(new Request(`${ORIGIN}${path}`, { method, headers: init.headers, body: init.body ?? null, duplex: "half" } as RequestInit), deps),
  };
}

const json = (value: unknown) => JSON.stringify(value);
const nothingStored = (hub: MemoryHub) => {
  assert.equal(hub.docs.size, 0, "a doc was stored");
  assert.equal(hub.assets.size, 0, "an asset was stored");
  assert.deepEqual(hub.calls, [], "the hub was asked to change something");
  assert.equal(hub.heartbeatAt, null, "a heartbeat was recorded");
};

describe("every response", () => {
  test("carries the base headers, whichever route made it", async () => {
    const s = setup();
    s.hub.docs.set("state", "{}");
    const requests: [string, string, { headers?: Record<string, string>; body?: BodyInit }?][] = [
      ["GET", "/servicecue"],
      ["GET", "/servicecue/weekend/audio"],
      ["GET", "/api/state"],
      ["GET", "/api/servicecue/config"],
      ["GET", "/api/publish/heartbeat"],
      ["GET", "/branding-images/missing.png"],
      ["GET", "/api/live"],
      ["GET", "/"],
      ["POST", "/api/state"],
      ["GET", "/_publish/v1/status"],
      ["GET", "/_publish/v1/status", { headers: AUTH }],
      ["PUT", "/_publish/v1/doc/state", { headers: AUTH, body: "{}" }],
      ["PUT", "/_publish/v1/doc/state", { headers: AUTH, body: "not json" }],
      ["POST", "/_publish/v1/doc/state", { headers: AUTH }],
      ["PUT", "/_publish/v1/asset/a.png", { headers: { ...AUTH, "Content-Type": "text/html" }, body: "x" }],
    ];
    for (const [method, path, init] of requests) {
      const res = await s.run(method, path, init);
      for (const [name, value] of BASE_HEADERS) assert.equal(res.headers.get(name), value, `${method} ${path} (${res.status}) ${name}`);
    }
  });

  test("a Worker with no secret carries them too", async () => {
    const s = setup({ token: undefined });
    const res = await s.run("PUT", "/_publish/v1/doc/state", { headers: AUTH, body: "{}" });
    assert.equal(res.status, 503);
    for (const [name, value] of BASE_HEADERS) assert.equal(res.headers.get(name), value, name);
  });
});

describe("plain http", () => {
  const over = (origin: string, method: string, path: string, headers: Record<string, string> = {}) => {
    const s = setup();
    return { s, res: handle(new Request(`${origin}${path}`, { method, headers }), { hub: s.hub, upgrade: async () => new Response(null), assets: async () => new Response("page"), token: TOKEN, now: () => 0 }) };
  };

  test("a visitor is sent to the same address over https, path and query kept", async () => {
    for (const path of ["/", "/servicecue", "/servicecue/weekend/audio?plan=123&text=lg", "/api/state", "/nothing-here"]) {
      const res = await over("http://servicecue.example.workers.dev", "GET", path).res;
      assert.equal(res.status, 301, path);
      assert.equal(res.headers.get("Location"), `https://servicecue.example.workers.dev${path}`, path);
      for (const [name, value] of BASE_HEADERS) assert.equal(res.headers.get(name), value, `${path} ${name}`);
    }
  });

  test("a publish is refused, even with the right token, and stores nothing", async () => {
    for (const [method, path] of [["GET", "/_publish/v1/status"], ["PUT", "/_publish/v1/doc/state"]] as const) {
      const { s, res } = over("http://servicecue.example.workers.dev", method, path, AUTH);
      const answer = await res;
      assert.equal(answer.status, 403, `${method} ${path}`);
      assert.deepEqual(await answer.json(), { error: "Publishing needs https" });
      nothingStored(s.hub);
    }
  });

  test("the loopback is served as it is, for wrangler dev", async () => {
    for (const origin of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
      const res = await over(origin, "GET", "/_publish/v1/status", AUTH).res;
      assert.notEqual(res.status, 301, origin);
      assert.notEqual(res.status, 403, origin);
    }
  });
});

describe("the publisher's token", () => {
  test("no token, or a wrong one, is a 401 JSON answer and stores nothing", async () => {
    const s = setup();
    const refused: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: "Basic abc" }, { Authorization: TOKEN }];
    for (const headers of refused) {
      const res = await s.run("PUT", "/_publish/v1/doc/state", { headers, body: json({ pcoConfigured: true }) });
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
      assert.equal(typeof ((await res.json()) as { error: string }).error, "string");
    }
    nothingStored(s.hub);
  });

  test("is checked before the path and the method, so a caller without one learns nothing about either", async () => {
    const s = setup();
    for (const [method, path] of [
      ["GET", "/_publish/v1/nope"],
      ["POST", "/_publish/v1/status"],
      ["PUT", "/_publish/v1/doc/not-a-key"],
      ["GET", "/_publish"],
      ["GET", "/servicecue/%2e%2e/_publish/v1/status"],
    ] as const) {
      assert.equal((await s.run(method, path)).status, 401, `${method} ${path}`);
    }
  });

  test("once past it, an unknown path is a 404 and a known one with the wrong method a 405 with Allow", async () => {
    const s = setup();
    assert.equal((await s.run("GET", "/_publish/v1/nope", { headers: AUTH })).status, 404);
    const res = await s.run("POST", "/_publish/v1/status", { headers: AUTH });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
    assert.equal((await s.run("PUT", "/_publish/v1/doc/not-a-key", { headers: AUTH, body: "{}" })).status, 404);
    nothingStored(s.hub);
  });

  test("a Worker with no secret, a short one, or one that is not a string, answers every publish request 503", async () => {
    for (const token of [undefined, "", "short", "x".repeat(PUBLISH_MIN_TOKEN_LENGTH - 1), {}, ["x".repeat(PUBLISH_MIN_TOKEN_LENGTH)]]) {
      const s = setup({ token });
      for (const headers of [{}, AUTH, { Authorization: `Bearer ${String(token ?? "")}` }]) {
        const res = await s.run("PUT", "/_publish/v1/doc/state", { headers, body: "{}" });
        assert.equal(res.status, 503, `${JSON.stringify(token)} ${JSON.stringify(headers)}`);
        assert.match(((await res.json()) as { error: string }).error, /PUBLISH_TOKEN/);
      }
      nothingStored(s.hub);
    }
  });

  test("the public side needs no token", async () => {
    const s = setup();
    s.hub.docs.set("service-types", "[]");
    assert.equal((await s.run("GET", "/api/service-types")).status, 200);
    assert.equal((await s.run("GET", "/servicecue")).status, 200);
  });

  test("the bare address is sent on to the landing page, with nothing else said", async () => {
    const s = setup();
    const res = await s.run("GET", "/");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "/servicecue");
    assert.equal(await res.text(), "");
  });
});

describe("docs", () => {
  test("a doc is stored exactly as sent and answered at its public path", async () => {
    const s = setup();
    const body = '{"layouts" : [ {"id":"1","order":0} ]}';
    const put = await s.run("PUT", "/_publish/v1/doc/servicecue-layouts", { headers: AUTH, body });
    assert.equal(put.status, 204);
    assert.equal(await put.text(), "");
    assert.equal(s.hub.docs.get("servicecue-layouts"), body, "stored verbatim");

    const get = await s.run("GET", "/api/servicecue/layouts");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(get.headers.get("cache-control"), "no-store");
    assert.equal(await get.text(), body, "answered verbatim");
  });

  test("a rundown is stored under its type and plan, and answered to that question", async () => {
    const s = setup();
    await s.run("PUT", "/_publish/v1/doc/rundown-12", { headers: AUTH, body: '{"planId":"1"}' });
    await s.run("PUT", "/_publish/v1/doc/rundown-12-34", { headers: AUTH, body: '{"planId":"34"}' });
    assert.equal(await (await s.run("GET", "/api/servicecue/rundown?serviceTypeId=12")).text(), '{"planId":"1"}');
    assert.equal(await (await s.run("GET", "/api/servicecue/rundown?serviceTypeId=12&planId=34")).text(), '{"planId":"34"}');
    assert.equal((await s.run("GET", "/api/servicecue/rundown?serviceTypeId=12&planId=35")).status, 404);
  });

  test("a doc that was never sent is a 404 that says so, and a rundown says which kind", async () => {
    const s = setup();
    const plain = await s.run("GET", "/api/servicecue/roles");
    assert.equal(plain.status, 404);
    assert.deepEqual(await plain.json(), { error: "That is not published" });
    const rundown = await s.run("GET", "/api/servicecue/rundown?serviceTypeId=1&planId=2");
    assert.equal(rundown.status, 404);
    assert.deepEqual(await rundown.json(), { error: "That plan is not published" });
  });

  test("the state is stored cut down to the public fields", async () => {
    const s = setup();
    const sent = { pcoConfigured: true, hourCycle: "24h", timezone: null, lanUrl: "http://192.168.1.9:8788", views: [{ id: "v" }], appName: "Example" };
    assert.equal((await s.run("PUT", "/_publish/v1/doc/state", { headers: AUTH, body: json(sent) })).status, 204);
    assert.deepEqual(JSON.parse(s.hub.docs.get("state")!), { hourCycle: "24h", pcoConfigured: true, timezone: null });
    assert.deepEqual(await (await s.run("GET", "/api/state")).json(), { hourCycle: "24h", pcoConfigured: true, timezone: null });
  });

  test("a body that is not JSON, or a state that is not one a page can draw, is a 400 and stores nothing", async () => {
    const s = setup();
    for (const [key, body] of [["service-types", "not json"], ["state", "[]"], ["state", json({ timezone: "Not/AZone" })], ["pco-live", "[1]"]] as const) {
      const res = await s.run("PUT", `/_publish/v1/doc/${key}`, { headers: AUTH, body });
      assert.equal(res.status, 400, `${key} ${body}`);
      assert.equal(typeof ((await res.json()) as { error: string }).error, "string");
    }
    nothingStored(s.hub);
  });

  test("a doc that grows in being stored is a 413, and stores nothing", async () => {
    const s = setup();
    const res = await s.run("PUT", "/_publish/v1/doc/pco-live", { headers: AUTH, body: `{"n":[${"1e20,".repeat(380_000)}1e20]}` });
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { error: string }).error, /once it is stored/);
    nothingStored(s.hub);
  });

  test("a doc can be removed", async () => {
    const s = setup();
    await s.run("PUT", "/_publish/v1/doc/service-types", { headers: AUTH, body: "[]" });
    assert.equal((await s.run("DELETE", "/_publish/v1/doc/service-types", { headers: AUTH })).status, 204);
    assert.equal((await s.run("GET", "/api/service-types")).status, 404);
  });

  test("a HEAD has the headers of the GET and no body", async () => {
    const s = setup();
    await s.run("PUT", "/_publish/v1/doc/service-types", { headers: AUTH, body: '[{"id":"1"}]' });
    const head = await s.run("HEAD", "/api/service-types");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await head.text(), "");
  });
});

describe("frames", () => {
  test("a frame is a write of the doc its channel is stored as", async () => {
    const s = setup();
    const res = await s.run("POST", "/_publish/v1/frame", { headers: AUTH, body: json({ channel: "pco:live", data: { mode: "item", currentItemId: "7" } }) });
    assert.equal(res.status, 204);
    assert.deepEqual(s.hub.calls, ["put pco-live"]);
    assert.equal(s.hub.docs.get("pco-live"), '{"mode":"item","currentItemId":"7"}', "a read after the frame is not older than it");
    assert.equal(await (await s.run("GET", "/api/pco/live")).text(), '{"mode":"item","currentItemId":"7"}');
  });

  test("each of the three channels is accepted, and null is a frame where nothing is live", async () => {
    const s = setup();
    for (const [channel, data] of [["pco:live", null], ["spl:history", null], ["stage:state-changed", { pcoConfigured: true }]] as const) {
      assert.equal((await s.run("POST", "/_publish/v1/frame", { headers: AUTH, body: json({ channel, data }) })).status, 204, channel);
    }
    assert.deepEqual(s.hub.calls, ["put pco-live", "put spl-current", "put state"]);
    assert.equal(s.hub.docs.get("spl-current"), "null");
  });

  test("a state frame is cut down to the public fields before it is kept", async () => {
    const s = setup();
    await s.run("POST", "/_publish/v1/frame", {
      headers: AUTH,
      body: json({ channel: "stage:state-changed", data: { accentColor: "#2e6691", lanUrl: "http://192.168.1.9:8788", outputs: [1], autoUpdate: {} } }),
    });
    assert.equal(s.hub.docs.get("state"), '{"accentColor":"#2e6691"}');
  });

  test("a channel that is not one of the three, or a frame that is not one, is a 400, and one that grows in being stored a 413", async () => {
    const s = setup();
    for (const body of [json({ channel: "publish:heartbeat", data: {} }), json({ channel: "pco:live" }), json([]), "not json", json({ channel: "stage:state-changed", data: { hourCycle: "9h" } })]) {
      assert.equal((await s.run("POST", "/_publish/v1/frame", { headers: AUTH, body })).status, 400, body);
    }
    const big = await s.run("POST", "/_publish/v1/frame", { headers: AUTH, body: `{"channel":"pco:live","data":{"n":[${"1e20,".repeat(380_000)}1e20]}}` });
    assert.equal(big.status, 413);
    nothingStored(s.hub);
  });
});

describe("heartbeats", () => {
  test("a heartbeat is recorded on the edge's clock, the publisher's kept apart", async () => {
    const s = setup();
    s.hub.clock = 4_999_000;
    const res = await s.run("POST", "/_publish/v1/heartbeat", { headers: AUTH, body: json({ at: 1_000, version: "1.27.0-beta.3" }) });
    assert.equal(res.status, 204);
    assert.equal(s.hub.heartbeatAt, 4_999_000, "the edge's clock, not the publisher's");
    assert.equal(s.hub.heartbeatSentAt, 1_000);
    assert.equal(s.hub.heartbeatVersion, "1.27.0-beta.3");
  });

  test("the public read gives the last heartbeat and the edge's clock now, and null before the first", async () => {
    const s = setup();
    assert.deepEqual(await (await s.run("GET", "/api/publish/heartbeat")).json(), { at: null, now: 5_000_000, build: BUILD });
    s.hub.clock = 4_990_000;
    await s.run("POST", "/_publish/v1/heartbeat", { headers: AUTH, body: json({ at: 1, version: "v" }) });
    const read = await s.run("GET", "/api/publish/heartbeat");
    // The build too, so a page living on this read (its network breaks the socket)
    // still reloads after a deploy.
    assert.deepEqual(await read.json(), { at: 4_990_000, now: 5_000_000, build: BUILD });
    assert.equal(read.headers.get("cache-control"), "no-store", "a clock sample must be fresh");
  });

  test("a heartbeat that is not {at, version} is a 400", async () => {
    const s = setup();
    for (const body of ["not json", json({ at: "1", version: "v" }), json({ at: -5, version: "v" })]) {
      assert.equal((await s.run("POST", "/_publish/v1/heartbeat", { headers: AUTH, body })).status, 400, body);
    }
    nothingStored(s.hub);
  });
});

describe("assets", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  test("an image is stored by name and served with its type, nosniff and a day's cache", async () => {
    const s = setup();
    const put = await s.run("PUT", "/_publish/v1/asset/logo-1a2b3c.png", { headers: { ...AUTH, "Content-Type": "image/png" }, body: png });
    assert.equal(put.status, 204);
    const get = await s.run("GET", "/branding-images/logo-1a2b3c.png");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "image/png");
    assert.equal(get.headers.get("x-content-type-options"), "nosniff");
    assert.equal(get.headers.get("cache-control"), "public, max-age=86400");
    assert.equal(get.headers.get("content-security-policy"), null, "a raster image needs no sandbox");
    assert.deepEqual(new Uint8Array(await get.arrayBuffer()), png);
  });

  test("an SVG is served sandboxed", async () => {
    const s = setup();
    await s.run("PUT", "/_publish/v1/asset/logo.svg", { headers: { ...AUTH, "Content-Type": "image/svg+xml" }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
    const get = await s.run("GET", "/branding-images/logo.svg");
    assert.equal(get.headers.get("content-type"), "image/svg+xml");
    assert.equal(get.headers.get("content-security-policy"), SVG_CSP);
    assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  });

  test("each of the five image types is accepted, parameters on the header and all", async () => {
    const s = setup();
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "IMAGE/PNG; charset=binary"]) {
      const res = await s.run("PUT", `/_publish/v1/asset/a${s.hub.assets.size}.img`, { headers: { ...AUTH, "Content-Type": type }, body: png });
      assert.equal(res.status, 204, type);
    }
    assert.equal(s.hub.assets.size, 6);
  });

  test("any other type, or none, is a 415 and stores nothing", async () => {
    const s = setup();
    for (const headers of [{ "Content-Type": "text/html" }, { "Content-Type": "image/avif" }, {}] as Record<string, string>[]) {
      const res = await s.run("PUT", "/_publish/v1/asset/a.png", { headers: { ...AUTH, ...headers }, body: "<script>alert(1)</script>" });
      assert.equal(res.status, 415, JSON.stringify(headers));
    }
    nothingStored(s.hub);
  });

  test("an empty body is a 400, and a name that cannot be an asset's is a 404", async () => {
    const s = setup();
    assert.equal((await s.run("PUT", "/_publish/v1/asset/a.png", { headers: { ...AUTH, "Content-Type": "image/png" }, body: "" })).status, 400);
    for (const name of ["a%20b.png", "a%2fb.png", ".."]) {
      assert.equal((await s.run("PUT", `/_publish/v1/asset/${name}`, { headers: { ...AUTH, "Content-Type": "image/png" }, body: png })).status, 404, name);
    }
    nothingStored(s.hub);
  });

  test("an image that was never sent is a 404", async () => {
    assert.equal((await setup().run("GET", "/branding-images/nope.png")).status, 404);
  });
});

describe("body limits", () => {
  const cap = PUBLISH_MAX_BODY_BYTES;

  test("a body over the cap is a 413 on every route that takes one, and stores nothing", async () => {
    const s = setup();
    const big = "a".repeat(cap + 1);
    const jsonBig = `{"x":"${"a".repeat(cap)}"}`;
    const cases: [string, string, Record<string, string>, string][] = [
      ["PUT", "/_publish/v1/doc/service-types", {}, jsonBig],
      ["POST", "/_publish/v1/frame", {}, jsonBig],
      ["POST", "/_publish/v1/heartbeat", {}, jsonBig],
      ["PUT", "/_publish/v1/manifest", {}, jsonBig],
      ["PUT", "/_publish/v1/asset/a.png", { "Content-Type": "image/png" }, big],
    ];
    for (const [method, path, extra, body] of cases) {
      const res = await s.run(method, path, { headers: { ...AUTH, ...extra }, body });
      assert.equal(res.status, 413, `${method} ${path}`);
      assert.match(((await res.json()) as { error: string }).error, /2000000/);
    }
    nothingStored(s.hub);
  });

  test("a body of exactly the cap is read", async () => {
    const s = setup();
    const filler = "a".repeat(cap - '{"x":""}'.length);
    const res = await s.run("PUT", "/_publish/v1/doc/service-types", { headers: AUTH, body: `{"x":"${filler}"}` });
    assert.equal(res.status, 204);
    assert.equal(s.hub.docs.get("service-types")!.length, cap);
  });

  test("a body that does not declare its length is counted as it arrives", async () => {
    const s = setup();
    const chunk = new Uint8Array(500_000).fill(97);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 6) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const res = await s.run("PUT", "/_publish/v1/asset/a.png", { headers: { ...AUTH, "Content-Type": "image/png" }, body });
    assert.equal(res.status, 413);
    assert.ok(sent <= 6, "it read the whole body, not up to the cap");
    nothingStored(s.hub);
  });
});

describe("manifest and status", () => {
  test("the manifest deletes every doc and asset it does not list, and says which", async () => {
    const s = setup();
    for (const key of ["state", "service-types", "rundown-1", "rundown-1-2"]) await s.run("PUT", `/_publish/v1/doc/${key}`, { headers: AUTH, body: "{}" });
    for (const name of ["a.png", "b.png"]) await s.run("PUT", `/_publish/v1/asset/${name}`, { headers: { ...AUTH, "Content-Type": "image/png" }, body: "x" });
    const res = await s.run("PUT", "/_publish/v1/manifest", { headers: AUTH, body: json({ docs: ["state", "rundown-1-2"], assets: ["b.png"] }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removedDocs: ["rundown-1", "service-types"], removedAssets: ["a.png"] });
    assert.deepEqual([...s.hub.docs.keys()].sort(), ["rundown-1-2", "state"]);
    assert.deepEqual([...s.hub.assets.keys()], ["b.png"]);
  });

  test("a manifest with one bad entry deletes nothing", async () => {
    const s = setup();
    await s.run("PUT", "/_publish/v1/doc/state", { headers: AUTH, body: "{}" });
    for (const body of [json({ docs: ["state", "stat"], assets: [] }), "not json"]) {
      assert.equal((await s.run("PUT", "/_publish/v1/manifest", { headers: AUTH, body })).status, 400, body);
    }
    assert.deepEqual([...s.hub.docs.keys()], ["state"]);
  });

  test("status reports the protocol, what is stored, the last heartbeat, the viewers and the build served", async () => {
    const s = setup();
    s.hub.viewers = 4;
    s.hub.clock = 4_000_000;
    await s.run("PUT", "/_publish/v1/doc/state", { headers: AUTH, body: "{}" });
    await s.run("POST", "/_publish/v1/heartbeat", { headers: AUTH, body: json({ at: 3_999_000, version: "1.0.0" }) });
    const res = await s.run("GET", "/_publish/v1/status", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      protocol: 1,
      docs: ["state"],
      assets: [],
      lastHeartbeat: { at: 4_000_000, sentAt: 3_999_000, version: "1.0.0" },
      viewers: 4,
      build: BUILD,
    });
    assert.equal(await (await s.run("HEAD", "/_publish/v1/status", { headers: AUTH })).text(), "");
  });
});

describe("the page", () => {
  test("every ServiceCue address serves the one document, with the policy and no caching", async () => {
    const s = setup();
    for (const path of ["/servicecue", "/servicecue/", "/servicecue/weekend/audio", "/servicecue/12/all-columns?plan=9&text=150&from=%2Fservicecue"]) {
      const res = await s.run("GET", path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(res.headers.get("content-security-policy"), htmlCsp(new URL(`${ORIGIN}${path}`)), path);
      assert.equal(res.headers.get("cache-control"), "no-cache");
      assert.match(await res.text(), /<title>viewer<\/title>/);
    }
  });

  test("the document is asked of the assets under its own name, never under the visitor's path", async () => {
    const s = setup();
    await s.run("GET", "/servicecue/weekend/audio");
    await s.run("HEAD", "/servicecue");
    assert.deepEqual(s.assetCalls, ["GET /servicecue.html", "HEAD /servicecue.html"]);
  });

  test("a visitor's conditional request gets the assets' 304", async () => {
    const s = setup();
    const res = await s.run("GET", "/servicecue", { headers: { "If-None-Match": '"v1"' } });
    assert.equal(res.status, 304);
    assert.equal(res.headers.get("content-security-policy") !== null, true);
  });

  test("a deploy with no page in it says so, with a 503, rather than a 404 a visitor might take for their own mistake", async () => {
    const s = setup({ assets: async () => new Response("missing", { status: 404 }) });
    const res = await s.run("GET", "/servicecue");
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /not part of this deployment/);
  });
});

describe("the live socket", () => {
  test("a plain GET is told to upgrade", async () => {
    const s = setup();
    const res = await s.run("GET", "/api/live");
    assert.equal(res.status, 426);
    assert.equal(res.headers.get("upgrade"), "websocket");
    assert.deepEqual(s.upgrades, []);
  });

  test("the page's own handshake, or a client that sends no Origin, is handed to the object", async () => {
    const s = setup();
    assert.equal((await s.run("GET", "/api/live", { headers: { Upgrade: "websocket", Origin: ORIGIN } })).status, 200);
    assert.equal((await s.run("GET", "/api/live", { headers: { Upgrade: "WebSocket" } })).status, 200);
    assert.equal(s.upgrades.length, 2);
  });

  test("another site's page cannot open it", async () => {
    const s = setup();
    for (const origin of ["https://evil.example", "https://servicecue.example.workers.dev.evil.example", "null", "not a url"]) {
      const res = await s.run("GET", "/api/live", { headers: { Upgrade: "websocket", Origin: origin } });
      assert.equal(res.status, 403, origin);
    }
    assert.deepEqual(s.upgrades, []);
  });

  test("anything but a GET is a 405", async () => {
    const s = setup();
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const res = await s.run(method, "/api/live", { headers: { Upgrade: "websocket" } });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get("allow"), "GET");
    }
    assert.deepEqual(s.upgrades, []);
  });
});

describe("telling a page which build is being served", () => {
  // A deploy whose page carries no id says so on the Worker's log (build.test.ts holds
  // the wording); here it is kept off the test output.
  beforeEach(() => void mock.method(console, "warn", () => {}));
  afterEach(() => {
    mock.restoreAll();
    __resetBuildNoticesForTests();
  });

  test("a heartbeat and a handshake are each given the id of the deployed page, read from its document", async () => {
    const s = setup();
    await s.run("POST", "/_publish/v1/heartbeat", { headers: AUTH, body: json({ at: 1, version: "v" }) });
    await s.run("GET", "/api/live", { headers: { Upgrade: "websocket", Origin: ORIGIN } });
    assert.deepEqual(s.hub.heartbeatBuilds, [BUILD]);
    assert.deepEqual(s.upgrades, [BUILD]);
    assert.deepEqual(s.assetCalls, ["GET /servicecue.html", "GET /servicecue.html"], "the document is asked for by its own name, once each");
  });

  test("the status answer names the build of the page being served, and null when there is none", async () => {
    const s = setup();
    s.hub.docs.set("state", "{}");
    const served = (await (await s.run("GET", "/_publish/v1/status", { headers: AUTH })).json()) as Record<string, unknown>;
    assert.equal(served.build, BUILD);
    assert.deepEqual(served.docs, ["state"], "the hub's own fields are still the answer");
    for (const assets of [async () => new Response("<!doctype html><title>older</title>"), async () => new Response("missing", { status: 404 })]) {
      const bare = (await (await setup({ assets }).run("GET", "/_publish/v1/status", { headers: AUTH })).json()) as Record<string, unknown>;
      assert.equal(bare.build, null);
      assert.equal(bare.protocol, 1, "no build is still a status");
    }
  });

  test("the status still answers, with no build and a line on the log, when the asset service throws", async () => {
    const logged: unknown[][] = [];
    mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const s = setup({
      assets: async () => {
        throw new Error("the asset service is down");
      },
    });
    s.hub.docs.set("state", "{}");
    const res = await s.run("GET", "/_publish/v1/status", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.build, null);
    assert.deepEqual(body.docs, ["state"]);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]![0]), /^\[servicecue-worker\] the status could not read/);
  });

  test("a heartbeat is still recorded, and answered, when the asset service throws", async () => {
    const logged: unknown[][] = [];
    mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const s = setup({
      assets: async () => {
        throw new Error("the asset service is down");
      },
    });
    const res = await s.run("POST", "/_publish/v1/heartbeat", { headers: AUTH, body: json({ at: 1_000, version: "1.27.0" }) });
    assert.equal(res.status, 204);
    assert.notEqual(s.hub.heartbeatAt, null, "the heartbeat was not recorded");
    assert.equal(s.hub.heartbeatSentAt, 1_000);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]![0]), /^\[servicecue-worker\] the heartbeat could not read/);
  });

  test("a viewer's handshake is still served, with no build, when the asset service throws", async () => {
    const logged: unknown[][] = [];
    mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const s = setup({
      assets: async () => {
        throw new Error("the asset service is down");
      },
    });
    const res = await s.run("GET", "/api/live", { headers: { Upgrade: "websocket" } });
    assert.equal(res.status, 200);
    assert.deepEqual(s.upgrades, [null]);
    assert.match(String(logged[0]![0]), /^\[servicecue-worker\] the viewer handshake could not read/);
  });

  test("an id a visitor puts on the handshake is not the one passed on", async () => {
    const s = setup();
    await s.run("GET", "/api/live", { headers: { Upgrade: "websocket", "X-Servicecue-Build": "ffffffffffff" } });
    assert.deepEqual(s.upgrades, [BUILD]);
    const bare = setup({ assets: async () => new Response("<html></html>") });
    await bare.run("GET", "/api/live", { headers: { Upgrade: "websocket", "X-Servicecue-Build": "ffffffffffff" } });
    assert.deepEqual(bare.upgrades, [null], "the visitor's own word was taken for the Worker's");
  });

  test("a deployment whose page carries no id, or has no page, says none, and still takes the church's heartbeat", async () => {
    for (const assets of [async () => new Response("<!doctype html><title>older</title>"), async () => new Response("missing", { status: 404 })]) {
      const s = setup({ assets });
      const res = await s.run("POST", "/_publish/v1/heartbeat", { headers: AUTH, body: json({ at: 1, version: "v" }) });
      assert.equal(res.status, 204);
      await s.run("GET", "/api/live", { headers: { Upgrade: "websocket" } });
      assert.deepEqual(s.hub.heartbeatBuilds, [null]);
      assert.deepEqual(s.upgrades, [null]);
    }
  });
});

describe("a failure in storage", () => {
  test("is a 500 that is neither a refusal nor an explanation, and is on the Worker's log", async () => {
    const s = setup();
    s.hub.getDoc = async () => {
      throw new Error("SQLITE_FULL: the disk is full");
    };
    s.hub.putDoc = async () => {
      throw new Error("SQLITE_TOOBIG");
    };
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const read = await s.run("GET", "/api/state");
      const write = await s.run("PUT", "/_publish/v1/doc/state", { headers: AUTH, body: "{}" });
      for (const res of [read, write]) {
        assert.equal(res.status, 500);
        assert.deepEqual(await res.clone().json(), { error: "The Worker could not answer that" });
        assert.doesNotMatch(await res.text(), /SQLITE|disk/, "an internal error reached the response");
        for (const [name, value] of BASE_HEADERS) assert.equal(res.headers.get(name), value, name);
      }
      assert.equal(logged.length, 2, "a failure was not written to the log");
      assert.match(String(logged[0]![0]), /^\[servicecue-worker\] GET \/api\/state failed:/);
      assert.match(String(logged[1]![0]), /^\[servicecue-worker\] PUT \/_publish\/v1\/doc\/state failed:/);
      assert.match(String((logged[0]![1] as Error).message), /SQLITE_FULL/, "the reason is on the log, whole");
    } finally {
      console.error = real;
    }
  });

  test("does not hide a refusal: a 4xx stays a 4xx", async () => {
    const s = setup();
    s.hub.getDoc = async () => {
      throw new Error("never reached for a path that is not a doc");
    };
    assert.equal((await s.run("GET", "/api/log")).status, 404);
    assert.equal((await s.run("PUT", "/_publish/v1/doc/state", { body: "{}" })).status, 401);
  });
});

describe("everything else", () => {
  const NOT_ANSWERED = [
    "/servicecue.html",
    "/servicecue/presets",
    "/servicecue/a/b/c",
    "/servicecue/weekend/..%2fapi/state",
    "/assets/..%2fservicecue.html",
    "/assets/app-abc123.js",
    "/favicon.svg",
    "/api/events",
    "/api/log",
    "/api/plans/upcoming",
    "/api/state?x=1",
    "/_headers",
    "/.env",
  ];

  test("is a 404, whatever the method, and never reaches the assets or the hub", async () => {
    const s = setup();
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
      for (const path of NOT_ANSWERED) {
        const res = await s.run(method, path);
        assert.equal(res.status, 404, `${method} ${path}`);
      }
    }
    assert.deepEqual(s.assetCalls, [], "the assets were asked for something a visitor named");
    nothingStored(s.hub);
  });

  test("forms the URL parser resolves are answered as the path they resolve to, which is only ever an allowed one or a 404", async () => {
    const s = setup();
    s.hub.docs.set("state", '{"pcoConfigured":true}');
    // These climb out of one allowed address into another: they are that other one.
    assert.equal((await s.run("GET", "/servicecue/../api/state")).status, 200);
    assert.equal((await s.run("GET", "/servicecue/%2e%2e/api/state")).status, 200);
    assert.equal((await s.run("GET", "/api\\state")).status, 200, "a backslash is a slash to the URL parser");
    // And these climb to somewhere that is not allowed.
    assert.equal((await s.run("GET", "/servicecue/../")).status, 302, "the bare address, which goes to the landing page");
    for (const path of ["/assets/../servicecue.html", "/servicecue/weekend/audio/../../../api/log"]) {
      assert.equal((await s.run("GET", path)).status, 404, path);
    }
    assert.deepEqual(s.assetCalls, []);
  });

  test("a public path with the wrong method is a 405 that names the methods it takes", async () => {
    const s = setup();
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      for (const path of ["/servicecue", "/api/state", "/branding-images/a.png", "/api/publish/heartbeat"]) {
        const res = await s.run(method, path);
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get("allow"), "GET, HEAD");
      }
    }
    assert.deepEqual(s.assetCalls, []);
    nothingStored(s.hub);
  });
});
