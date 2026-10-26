// The Worker, whole, in the real runtime.
//
// The root suite runs every part of the Worker that does not import a Workers API,
// against an in-memory hub. What it cannot reach is what only workerd does: the Durable
// Object's SQLite storage, the viewers' sockets on the WebSocket Hibernation API (their
// auto-response timestamps, the closes the runtime accepts and refuses), and the static
// asset service that answers some paths without the Worker. This starts `wrangler dev`
// (workerd, on localhost, with its own empty storage and a made-up token) and drives
// those, the way a publisher and a visitor do.
//
//   npm --prefix publish/servicecue test
//
// It needs this package's dependencies installed, so it is not part of the root
// `npm test`. Nothing is sent to Cloudflare: `wrangler dev` runs locally, given no account.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { open } from "./raw-socket.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.join(HERE, "..");
const TOKEN = randomBytes(32).toString("base64");
/** The build id the stand-in page is stamped with, and the tag a build stamps it with (VIEWER_BUILD_META in the contract). */
const BUILD = "0123456789ab";
const BUILD_META = `<meta name="servicecue-build" content="${BUILD}" />`;
/** Small limits, so the cap, the share and the idle rule can each be reached in seconds. See capacity.ts. */
const MAX_VIEWERS = 6;
const PER_ADDRESS = 3;
const IDLE_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A port nothing holds, by asking the OS for one and giving it back. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

let child;
let base;
let log = "";

before(async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "servicecue-worker-"));
  // The page's files, stood in for: the Worker needs a folder to serve them from, and this
  // test is about what it does with a request, not what the page looks like. `assets/nested`
  // and `assets/readme.txt` are what no build writes: they show which paths the asset service
  // answers by itself and which the Worker is asked about. `_headers` is what it reads its
  // headers from.
  const assets = path.join(scratch, "assets-dir");
  mkdirSync(path.join(assets, "assets", "nested"), { recursive: true });
  writeFileSync(path.join(assets, "servicecue.html"), `<!doctype html><title>viewer</title>${BUILD_META}`);
  writeFileSync(path.join(assets, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(path.join(assets, "assets", "nested", "x.js"), "console.log(2)");
  writeFileSync(path.join(assets, "assets", "readme.txt"), "not a file the build writes");
  writeFileSync(path.join(assets, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(path.join(assets, "_headers"), "/assets/*\n  X-From: the-headers-file\n\n/favicon.svg\n  X-From: the-headers-file\n");
  const [port, inspector] = [await freePort(), await freePort()];
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [
      path.join(PACKAGE, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--inspector-port", String(inspector),
      "--assets", assets,
      "--persist-to", path.join(scratch, "state"),
      "--var", `PUBLISH_TOKEN:${TOKEN}`,
      "--var", `MAX_VIEWERS:${MAX_VIEWERS}`,
      "--var", `MAX_VIEWERS_PER_ADDRESS:${PER_ADDRESS}`,
      "--var", `VIEWER_IDLE_MS:${IDLE_MS}`,
    ],
    { cwd: PACKAGE, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(scratch, "logs") } },
  );
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (log.includes("Ready on")) break;
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`);
    if (Date.now() > deadline) throw new Error(`wrangler dev was not ready in a minute:\n${log}`);
    await sleep(100);
  }
});

after(() => {
  child?.kill();
});

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const send = (method, route, body, headers = auth) =>
  fetch(base + route, { method, headers, body: body === undefined || typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
const put = (key, body, headers) => send("PUT", `/_publish/v1/doc/${key}`, body, headers);
const frame = (channel, data) => send("POST", "/_publish/v1/frame", { channel, data });
const viewers = async () => (await (await send("GET", "/_publish/v1/status")).json()).viewers;

let nextAddress = 1;
/** A visitor on an address of its own, so one test's sockets are not another's share. Waits for the replay. */
async function viewer(address = `198.51.100.${nextAddress++}`) {
  const opened = await open(base, { "CF-Connecting-IP": address });
  assert.ok(opened.socket, `the socket did not open: ${opened.status} ${opened.body}`);
  await opened.socket.until((s) => s.frames().some((f) => f.channel === "publish:heartbeat"), "the replay");
  return opened.socket;
}
/** Wait until no sockets are held, so a test that needs the whole page starts from an empty one. */
async function allGone() {
  const deadline = Date.now() + 5000;
  while ((await viewers()) !== 0) {
    if (Date.now() > deadline) throw new Error("sockets are still held");
    await sleep(50);
  }
}

describe("the publisher", () => {
  test("is refused without the token, and a doc is stored and answered exactly as sent", async () => {
    assert.equal((await put("service-types", "[]", {})).status, 401);
    assert.equal((await put("service-types", "[]", { Authorization: "Bearer nope" })).status, 401);
    const body = '[ {"id":"1001",  "name":"Weekend"} ]';
    assert.equal((await put("service-types", body)).status, 204);
    const got = await fetch(`${base}/api/service-types`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), body, "the doc was not answered as it was stored");
  });

  test("a frame is the doc: a read after it is as new, and removing the doc leaves no frame to replay", async () => {
    assert.equal((await frame("pco:live", { mode: "item", currentItemId: "7" })).status, 204);
    assert.deepEqual(await (await fetch(`${base}/api/pco/live`)).json(), { mode: "item", currentItemId: "7" });
    const before = await viewer();
    assert.deepEqual(before.frames().filter((f) => f.channel === "pco:live"), [{ channel: "pco:live", data: { mode: "item", currentItemId: "7" }, replay: true }]);
    before.destroy();

    assert.equal((await send("DELETE", "/_publish/v1/doc/pco-live")).status, 204);
    const after = await viewer();
    assert.deepEqual(after.frames().filter((f) => f.channel === "pco:live"), [], "a frame outlived its doc");
    after.destroy();
  });

  test("an image keeps its bytes, and an SVG is sandboxed", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 1, 2, 3]);
    assert.equal((await send("PUT", "/_publish/v1/asset/logo-abc.png", bytes, { ...auth, "Content-Type": "image/png" })).status, 204);
    const png = await fetch(`${base}/branding-images/logo-abc.png`);
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), bytes);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    assert.equal((await send("PUT", "/_publish/v1/asset/logo-abc.svg", svg, { ...auth, "Content-Type": "image/svg+xml" })).status, 204);
    const got = await fetch(`${base}/branding-images/logo-abc.svg`);
    assert.equal(got.headers.get("content-security-policy"), "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    assert.equal(await got.text(), svg);
  });

  test("a body at the cap is stored, and one over it is refused, a stringified one included", async () => {
    const cap = 2_000_000;
    const exact = JSON.stringify({ x: "a".repeat(cap - '{"x":""}'.length) });
    assert.equal(exact.length, cap);
    assert.equal((await put("servicecue-layouts", exact)).status, 204);
    assert.equal((await (await fetch(`${base}/api/servicecue/layouts`)).text()).length, cap);
    assert.equal((await put("servicecue-layouts", JSON.stringify({ x: "a".repeat(cap) }))).status, 413);
    // 1e20 is five bytes as sent and twenty-one once stored: a body under the cap that is over it.
    const small = `{"channel":"pco:live","data":{"n":[${"1e20,".repeat(380_000)}1e20]}}`;
    assert.ok(small.length < cap);
    const res = await send("POST", "/_publish/v1/frame", small);
    assert.equal(res.status, 413, "a state that grew in being stored reached the database");
    assert.equal(await res.text(), JSON.stringify({ error: `pco:live data is over ${cap} bytes once it is stored` }));
  });

  test("a state with a time zone the runtime does not know is refused, and one it does is kept", async () => {
    assert.equal((await put("state", { timezone: "Not/AZone", hourCycle: "12h" })).status, 400);
    assert.equal((await put("state", { timezone: "America/Chicago", hourCycle: "12h", lanUrl: "http://192.168.1.10:8788" })).status, 204);
    assert.deepEqual(await (await fetch(`${base}/api/state`)).json(), { hourCycle: "12h", timezone: "America/Chicago" });
  });

  test("the manifest deletes what it does not list", async () => {
    const res = await send("PUT", "/_publish/v1/manifest", { docs: ["state"], assets: ["logo-abc.png"] });
    assert.equal(res.status, 200);
    const removed = await res.json();
    assert.ok(removed.removedDocs.includes("servicecue-layouts") && removed.removedDocs.includes("service-types"));
    assert.deepEqual(removed.removedAssets, ["logo-abc.svg"]);
    assert.equal((await fetch(`${base}/api/service-types`)).status, 404);
    assert.equal((await fetch(`${base}/branding-images/logo-abc.svg`)).status, 404);
    assert.equal((await fetch(`${base}/api/state`)).status, 200);
  });
});

describe("a viewer", () => {
  test("is replayed what is stored, in order and marked, and the heartbeat last with the edge's clock and the build", async () => {
    const first = await viewer();
    const beat = first.frames().at(-1);
    assert.deepEqual(Object.keys(beat.data).sort(), ["at", "build", "now"]);
    assert.equal(beat.data.at, null, "no heartbeat has been sent yet");
    assert.equal(beat.data.build, BUILD);
    assert.ok(Math.abs(beat.data.now - Date.now()) < 5000, "now is not the edge's clock");
    assert.equal(beat.replay, true);
    first.destroy();

    await frame("stage:state-changed", { pcoConfigured: true, lanUrl: "http://192.168.1.10:8788" });
    await frame("spl:history", null);
    await frame("pco:live", { mode: "item", currentItemId: "8" });
    const second = await viewer();
    assert.deepEqual(
      second.frames().map((f) => f.channel),
      ["pco:live", "spl:history", "stage:state-changed", "publish:heartbeat"],
    );
    assert.deepEqual(second.frames()[2], { channel: "stage:state-changed", data: { pcoConfigured: true }, replay: true }, "the state was not cut down");
    assert.ok(second.frames().every((f) => f.replay === true));
    second.destroy();
  });

  test("hears a frame the moment it is published, unmarked", async () => {
    const v = await viewer();
    await frame("pco:live", { mode: "item", currentItemId: "9" });
    await v.until((s) => s.messages.some((m) => m.includes('"currentItemId":"9"')), "the new frame");
    assert.deepEqual(v.frames().at(-1), { channel: "pco:live", data: { mode: "item", currentItemId: "9" } });
    v.destroy();
  });

  test("is told which docs changed, and only when they did", async () => {
    const v = await viewer();
    const docs = () => v.frames().filter((f) => f.channel === "publish:docs").map((f) => f.data);
    await put("service-types", '[{"id":"1"}]');
    await v.until(() => docs().length === 1, "the first change");
    assert.deepEqual(docs(), [{ keys: ["service-types"] }]);

    await put("service-types", '[{"id":"1"}]'); // published again, unchanged
    await put("servicecue-roles", "[]");
    await v.until(() => docs().length === 2, "the second change");
    assert.deepEqual(docs()[1], { keys: ["servicecue-roles"] }, "a doc published again unchanged was announced");

    await send("DELETE", "/_publish/v1/doc/servicecue-roles");
    await v.until(() => docs().length === 3, "the removal");
    assert.deepEqual(docs()[2], { keys: ["servicecue-roles"] });

    // A frame is told as a frame and not as a doc, and a manifest names what it removed.
    await put("pco-live", '{"mode":"none"}');
    await v.until((s) => s.messages.some((m) => m.includes('"mode":"none"')), "the frame");
    assert.equal(docs().length, 3, "a frame doc was announced as a doc");
    const stored = (await (await send("GET", "/_publish/v1/status")).json()).docs;
    await send("PUT", "/_publish/v1/manifest", { docs: ["state", "pco-live"], assets: ["logo-abc.png"] });
    await v.until(() => docs().length === 4, "the manifest's removals");
    assert.deepEqual(docs()[3], { keys: stored.filter((key) => key !== "state" && key !== "pco-live") });
    assert.ok(docs()[3].keys.includes("service-types"));
    v.destroy();
  });

  test("is told of a heartbeat by the edge's clock and the build, without the church's version", async () => {
    const v = await viewer();
    const before = Date.now();
    assert.equal((await send("POST", "/_publish/v1/heartbeat", { at: 1_000, version: "9.9.9-secret" })).status, 204);
    await v.until((s) => s.frames().filter((f) => f.channel === "publish:heartbeat").length === 2, "the heartbeat");
    const beat = v.frames().at(-1);
    assert.deepEqual(Object.keys(beat.data).sort(), ["at", "build"], "a live heartbeat carries when and which build, and no more");
    assert.ok(beat.data.at >= before - 1000 && beat.data.at <= Date.now() + 1000, `at is not the edge's clock: ${beat.data.at}`);
    assert.equal(beat.data.build, BUILD);
    assert.doesNotMatch(JSON.stringify(beat), /secret/);
    const read = await (await fetch(`${base}/api/publish/heartbeat`)).json();
    assert.equal(read.at, beat.data.at);
    const status = await (await send("GET", "/_publish/v1/status")).json();
    assert.deepEqual(status.lastHeartbeat, { at: beat.data.at, sentAt: 1_000, version: "9.9.9-secret" });
    assert.equal(status.build, BUILD, "the status names the build of the page the asset service holds");
    v.destroy();

    const late = await viewer();
    assert.deepEqual(late.frames().at(-1).data.at, beat.data.at, "the replay is the last heartbeat");
    assert.ok(late.frames().at(-1).data.now >= beat.data.at);
    late.destroy();
  });

  test("is answered 'pong' to 'ping', and closed for anything else it sends", async () => {
    const v = await viewer();
    v.sendText("ping");
    await v.until((s) => s.messages.includes("pong"), "pong");
    assert.equal(v.closed, null, "a ping closed the socket");

    v.sendText(JSON.stringify({ channel: "pco:live", data: { forged: true } }));
    await v.until((s) => s.closed !== null, "the close");
    assert.equal(v.closed.code, 1008);
    assert.notDeepEqual(await (await fetch(`${base}/api/pco/live`)).json(), { forged: true });

    const binary = await viewer();
    binary.sendBinary([1, 2, 3]);
    await binary.until((s) => s.closed !== null, "the close of a binary message");
    assert.equal(binary.closed.code, 1008);
  });

  test("a close it is sent is answered with a code that can be sent, whatever the client chose", async () => {
    const cases = [
      [1000, 1000],
      [1001, 1001],
      [3000, 3000],
      [4999, 4999],
      [1004, 1000],
      [1005, 1000],
      [1006, 1000],
      [1015, 1000],
      [999, 1000],
      [2999, 1000],
      [5000, 1000],
    ];
    for (const [sent, answered] of cases) {
      const v = await viewer();
      v.sendClose(sent, "bye");
      await v.until((s) => s.closed !== null, `the answer to a close with ${sent}`);
      assert.equal(v.closed.code, answered, `a close with ${sent}`);
      v.destroy();
    }
    assert.doesNotMatch(log, /InvalidAccessError/, "the object threw on a close code it could not send");
  });

  test("is counted while connected, and not after", async () => {
    await allGone();
    const a = await viewer();
    const b = await viewer();
    assert.equal(await viewers(), 2);
    a.destroy();
    b.destroy();
    await allGone();
  });

  test("is turned away from another site's page, and from a plain GET", async () => {
    assert.equal((await fetch(`${base}/api/live`)).status, 426);
    assert.equal((await open(base, { Origin: "https://evil.example" })).status, 403);
    const own = await open(base, { Origin: base });
    assert.ok(own.socket, "the page's own origin was turned away");
    own.socket.destroy();
  });
});

describe("who may hold a socket", () => {
  test("one address holds only its share, and another is not affected", async () => {
    await allGone();
    const address = "203.0.113.50";
    const held = [];
    for (let i = 0; i < PER_ADDRESS; i++) held.push(await viewer(address));
    const refused = await open(base, { "CF-Connecting-IP": address });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers["retry-after"], "30");
    const other = await viewer("203.0.113.51");
    assert.equal(await viewers(), PER_ADDRESS + 1, "the refused socket was held, or a held one was closed for it");
    for (const s of [...held, other]) s.destroy();
    await allGone();
  });

  test("a full page turns away the next, until a socket that has stopped pinging can be closed for it, and one that pings is kept", async () => {
    await allGone();
    // Six sockets on two addresses fill the page. One of them pings; the rest never do.
    const quiet = [];
    for (let i = 0; i < PER_ADDRESS; i++) quiet.push(await viewer("203.0.113.60"));
    const mixed = [await viewer("203.0.113.61"), await viewer("203.0.113.61"), await viewer("203.0.113.61")];
    const pinger = mixed[0];
    assert.equal(await viewers(), MAX_VIEWERS);

    const full = await open(base, { "CF-Connecting-IP": "203.0.113.62" });
    assert.equal(full.status, 503, "a page with no idle socket let another in");

    // Past the idle time, with one of them having pinged all along.
    const until = Date.now() + IDLE_MS + 700;
    while (Date.now() < until) {
      pinger.sendText("ping");
      await sleep(400);
    }
    const admitted = await open(base, { "CF-Connecting-IP": "203.0.113.62" });
    assert.ok(admitted.socket, `an idle page was still full: ${admitted.status} ${admitted.body}`);
    await Promise.all([...quiet, mixed[1], mixed[2]].map((s) => s.until((x) => x.closed !== null, "the close of an idle socket")));
    for (const s of [...quiet, mixed[1], mixed[2]]) assert.equal(s.closed.code, 1001, "an idle socket was closed with another code");
    assert.equal(pinger.closed, null, "a socket that pings was closed as idle");
    admitted.socket.destroy();
    pinger.destroy();
    await allGone();
  });
});

describe("the files the asset service answers itself", () => {
  const getRaw = (rawPath) => fetch(base + rawPath);

  test("are answered without the Worker: a path only the asset service would serve, and its own headers", async () => {
    for (const file of ["/assets/app-abc123.js", "/assets/nested/x.js", "/favicon.svg"]) {
      const res = await getRaw(file);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers.get("x-from"), "the-headers-file", `${file} did not take its headers from the headers file`);
      assert.equal(res.headers.get("x-robots-tag"), null, `${file} went through the Worker`);
    }
  });

  test("are only the types wrangler.jsonc names: any other file under /assets is the Worker's 404", async () => {
    const res = await getRaw("/assets/readme.txt");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", "the Worker did not answer it");
    assert.deepEqual(await res.json(), { error: "Not found" });
  });

  test("never reach the page's own document, or the headers file", async () => {
    for (const p of ["/servicecue.html", "/_headers", "/assets/..%2fservicecue.html", "/assets/%2e%2e%2fservicecue.html", "/assets/../servicecue.html"]) {
      const res = await getRaw(p);
      assert.equal(res.status, 404, p);
      assert.equal(res.headers.get("x-robots-tag"), "noindex", `${p} was not the Worker's answer`);
    }
    const page = await getRaw("/servicecue/weekend/audio");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /^default-src 'self'; /);
  });
});
