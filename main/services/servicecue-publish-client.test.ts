// The sender's HTTP half, against a real server on an ephemeral port.
//
// The page is somebody else's server and the app talks to it with a credential, so what the client will
// not do matters as much as what it does: it does not follow a redirect (the token would go wherever the
// answer pointed), it does not wait past its ceiling, it does not read a body it was not asked to read, and
// it does not send what the page would only refuse.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { PUBLISH_MAX_BODY_BYTES } from "../types/servicecue-publish.js";
import { FakeReceiver, PAGE_STATUS } from "./fixtures/publish-receiver.js";
import { within } from "./fixtures/within.js";
import { createPushClient, type PushClient, type PushResult } from "./servicecue-publish-client.js";
import { parsePublishUrl } from "./servicecue-publish-rules.js";

const TOKEN = "tok-canary-".padEnd(40, "0");

describe("the push client", () => {
  let page: FakeReceiver;
  let client: PushClient;
  const clientFor = (origin: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}): PushClient => {
    const parsed = parsePublishUrl(origin);
    assert.ok(parsed.ok);
    return createPushClient({ origin: parsed.origin, token: TOKEN, ...extra });
  };

  beforeEach(async () => {
    page = await FakeReceiver.start();
    client = clientFor(page.origin);
  });
  afterEach(async () => {
    await page.close();
  });

  it("sends every request with the bearer token, and the right verb, path and body", async () => {
    assert.deepEqual(await client.putDoc("rundown-100-1001", '{"a":1}'), { ok: true });
    assert.deepEqual(await client.putDoc("servicecue-config", "null"), { ok: true });
    assert.deepEqual(await client.postFrame("pco:live", { mode: "item" }), { ok: true });
    assert.deepEqual(await client.putAsset("0123456789abcdef.png", new Uint8Array([1, 2, 3]), "image/png"), { ok: true });
    assert.deepEqual(await client.heartbeat(1234, "1.2.3"), { ok: true });
    assert.deepEqual(await client.putManifest(["state"], ["0123456789abcdef.png"]), {
      ok: true,
      removed: { docs: ["pco-live", "rundown-100-1001", "servicecue-config"], assets: [] },
    });
    assert.equal((await client.status()).ok, true);

    assert.deepEqual(
      page.requests.map((r) => `${r.method} ${r.path}`),
      [
        "PUT /_publish/v1/doc/rundown-100-1001",
        "PUT /_publish/v1/doc/servicecue-config",
        "POST /_publish/v1/frame",
        "PUT /_publish/v1/asset/0123456789abcdef.png",
        "POST /_publish/v1/heartbeat",
        "PUT /_publish/v1/manifest",
        "GET /_publish/v1/status",
      ],
    );
    for (const r of page.requests) assert.equal(r.headers.authorization, `Bearer ${TOKEN}`, `${r.method} ${r.path}`);
    assert.equal(page.requests[0]!.body, '{"a":1}');
    assert.equal(page.requests[0]!.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(page.requests[2]!.body), { channel: "pco:live", data: { mode: "item" } });
    assert.deepEqual([...page.requests[3]!.bytes], [1, 2, 3]);
    assert.equal(page.requests[3]!.headers["content-type"], "image/png");
    assert.deepEqual(JSON.parse(page.requests[4]!.body), { at: 1234, version: "1.2.3" });
    assert.deepEqual(JSON.parse(page.requests[5]!.body), { docs: ["state"], assets: ["0123456789abcdef.png"] });
    // The token rides in a header only.
    for (const r of page.requests) assert.equal(`${r.path}${r.body}`.includes(TOKEN), false, "the token is in a URL or a body");
  });

  it("never sends a frame without its data: null says none, and a missing key is a 400", async () => {
    await client.postFrame("pco:live", null);
    await client.postFrame("spl:history", undefined);
    assert.deepEqual(page.frames(), [
      { channel: "pco:live", data: null },
      { channel: "spl:history", data: null },
    ]);
  });

  it("cuts a version to the 64 characters the page takes, and never sends an empty one", async () => {
    // The page answers 400 to a heartbeat whose version is empty or longer than that, and a 400 to a heartbeat reads as an address that is not the page.
    await client.heartbeat(1, "v".repeat(100));
    await client.heartbeat(2, "");
    assert.deepEqual(page.heartbeats(), [
      { at: 1, version: "v".repeat(64) },
      { at: 2, version: "unknown" },
    ]);
  });

  it("names what the page answered by what the request was about", async () => {
    // [status, a request about one thing the page holds, a request about the page itself]
    const table: [number, string, string][] = [
      [401, "auth", "auth"],
      [403, "blocked", "blocked"],
      [429, "limited", "limited"],
      [413, "refused", "rejected"],
      [404, "refused", "rejected"],
      [400, "refused", "rejected"],
      [418, "refused", "rejected"],
      [500, "server", "server"],
      [502, "server", "server"],
      [503, "server", "no-token"],
    ];
    for (const [status, item, itself] of table) {
      page.respond = () => ({ status });
      const doc = await client.putDoc("state", "{}");
      const beat = await client.heartbeat(1, "v");
      const stat = await client.status();
      for (const [what, r, kind] of [["a document", doc, item], ["the heartbeat", beat, itself], ["the status", stat, itself]] as const) {
        assert.equal(r.ok, false, `${status} on ${what}`);
        if (!r.ok) {
          assert.equal(r.kind, kind, `${status} on ${what}`);
          assert.equal(r.status, status);
          assert.equal(r.message.includes(TOKEN), false, "the token is in an error text");
        }
      }
    }
  });

  it("says a 403 is a rule in front of the page and a 503 to the lightest request may be the page having no token", async () => {
    page.respond = () => ({ status: 403 });
    const blocked = await client.heartbeat(1, "v");
    assert.ok(!blocked.ok && /Cloudflare rule/.test(blocked.message) && !/token/.test(blocked.message), JSON.stringify(blocked));
    page.respond = () => ({ status: 503 });
    const noToken = await client.heartbeat(1, "v");
    assert.ok(!noToken.ok && /no publishing token set yet \(or one under 32 characters\)/.test(noToken.message), JSON.stringify(noToken));
    const docLevel = await client.putDoc("state", "{}");
    assert.ok(!docLevel.ok && !/token/.test(docLevel.message), "a 503 to a document is not the page having no token");
  });

  it("does NOT follow a redirect: a 302 to another port is never fetched", async () => {
    const elsewhere = await FakeReceiver.start();
    try {
      for (const status of [301, 302, 307, 308]) {
        page.respond = () => ({ status, headers: { Location: `${elsewhere.origin}/_publish/v1/doc/state` } });
        const r = await client.putDoc("state", "{}");
        assert.equal(r.ok, false, `a ${status} was followed and answered as though it were the page`);
        if (!r.ok) assert.equal(r.kind, "redirect", `status ${status}`);
      }
      assert.equal(elsewhere.requests.length, 0, "the redirect target was fetched, carrying the token");
    } finally {
      await elsewhere.close();
    }
  });

  it("reports a refused connection and a silent page as unreachable, within its own ceiling", async () => {
    const closed = await FakeReceiver.start();
    const origin = closed.origin;
    await closed.close();
    const gone = await clientFor(origin).putDoc("state", "{}");
    assert.ok(!gone.ok && gone.kind === "unreachable");

    page.respond = () => "hang";
    // Bounded by the test, so a client with no ceiling fails here instead of hanging the suite.
    const r = await within(clientFor(page.origin, { timeoutMs: 150 }).putDoc("state", "{}"), "a request to a silent page to give up on its own", 3000);
    assert.ok(!r.ok && r.kind === "unreachable" && /No answer/.test(r.message), JSON.stringify(r));
  });

  it("gives a large body longer: a logo on a slow uplink is not a failure", async () => {
    // The page takes 400 ms to answer. A request with no body waits 100 ms and gives up; one carrying 450 KB waits 100 ms and a second more for every 100 KB.
    page.respond = () => ({ status: 204, delayMs: 400 });
    const small = await clientFor(page.origin, { timeoutMs: 100 }).putDoc("state", "{}");
    assert.ok(!small.ok && small.kind === "unreachable", JSON.stringify(small));
    const big = await clientFor(page.origin, { timeoutMs: 100 }).putAsset("a.png", new Uint8Array(450_000), "image/png");
    assert.deepEqual(big, { ok: true });
  });

  it("stops a request in flight when told to, and refuses new ones", async () => {
    page.respond = () => "hang";
    const stop = new AbortController();
    const c = clientFor(page.origin, { signal: stop.signal });
    const inFlight = c.putDoc("state", "{}");
    setTimeout(() => stop.abort(), 50);
    const r = await inFlight;
    assert.ok(!r.ok && r.kind === "aborted");
    const after = await c.heartbeat(1, "v");
    assert.ok(!after.ok && after.kind === "aborted");
    assert.equal(page.requests.length, 1, "a request was made after the stop");
  });

  it("does not send a body over the page's cap, and counts bytes rather than characters", async () => {
    const atTheCap = JSON.stringify("x".repeat(PUBLISH_MAX_BODY_BYTES - 2));
    assert.equal(Buffer.byteLength(atTheCap), PUBLISH_MAX_BODY_BYTES);
    assert.deepEqual(await client.putDoc("servicecue-layouts", atTheCap), { ok: true }, "a body exactly at the cap was refused");
    assert.equal(page.requests.length, 1);

    // A document, one in two-byte characters (fewer characters than the cap, more bytes), an image and a frame, each one over.
    const over: PushResult[] = [
      await client.putDoc("servicecue-layouts", JSON.stringify("x".repeat(PUBLISH_MAX_BODY_BYTES - 1))),
      await client.putDoc("servicecue-layouts", JSON.stringify("é".repeat(PUBLISH_MAX_BODY_BYTES / 2))),
      await client.putAsset("a.png", new Uint8Array(PUBLISH_MAX_BODY_BYTES + 1), "image/png"),
      await client.postFrame("pco:live", { pad: "x".repeat(PUBLISH_MAX_BODY_BYTES) }),
    ];
    for (const r of over) assert.ok(!r.ok && r.kind === "refused" && /over the page's limit/.test(r.message), JSON.stringify(r).slice(0, 200));
    assert.equal(page.requests.length, 1, "an oversized body was sent for the page to refuse");
  });

  it("reads the status of an answer and never its body: a body that does not end does not hold it", async () => {
    // The page sends the status line and a first byte, and never finishes. A client that waited for the whole body would wait out its ceiling.
    const started = performance.now();
    page.respond = () => ({ status: 200, body: "partial", open: true });
    assert.deepEqual(await client.putDoc("state", "{}"), { ok: true });
    assert.deepEqual(await client.heartbeat(1, "v"), { ok: true });
    page.respond = () => ({ status: 502, body: "partial", open: true });
    const r = await client.putDoc("state", "{}");
    assert.ok(!r.ok && r.kind === "server");
    assert.ok(performance.now() - started < 2000, "the client waited on a body it was never going to use");
  });

  it("reads what the manifest says the page removed, and a manifest answer it cannot read is still an accepted manifest", async () => {
    page.respond = () => ({ status: 200, body: JSON.stringify({ removedDocs: ["rundown-100-9"], removedAssets: ["old.png"], extra: 1 }) });
    assert.deepEqual(await client.putManifest(["state"], []), { ok: true, removed: { docs: ["rundown-100-9"], assets: ["old.png"] } });
    for (const body of ["", "<html>", "{}", '{"removedDocs":"x","removedAssets":[]}', '{"removedDocs":[1],"removedAssets":[]}']) {
      page.respond = () => ({ status: 200, body });
      assert.deepEqual(await client.putManifest(["state"], []), { ok: true }, body);
    }
    page.respond = () => ({ status: 204 });
    assert.deepEqual(await client.putManifest(["state"], []), { ok: true });
  });

  it("reads the lists in the status answer, and nothing else of it", async () => {
    const answer = { ...PAGE_STATUS, docs: ["rundown-100", "state"], assets: ["a.png"], viewers: 2, lastHeartbeat: { at: 1, sentAt: 1, version: "v" }, extra: "ignored" };
    page.respond = () => ({ status: 200, body: JSON.stringify(answer) });
    assert.deepEqual(await client.status(), { ok: true, page: { docs: ["rundown-100", "state"], assets: ["a.png"] } });
  });

  it("refuses an answer that is not a page's status, one over the cap, one that stalls, and a page on another protocol", async () => {
    const notTheStatus = [
      "<html>welcome</html>",
      "{}",
      '{"protocol":1,"docs":3,"assets":1}',
      '{"protocol":"1","docs":[],"assets":[]}',
      '{"protocol":1,"docs":[1],"assets":[]}',
      JSON.stringify({ ...PAGE_STATUS, pad: "x".repeat(2_000_000) }),
    ];
    for (const body of notTheStatus) {
      page.respond = () => ({ status: 200, body });
      const r = await client.status();
      assert.ok(!r.ok && r.kind === "rejected", body.slice(0, 40));
    }

    page.respond = () => ({ status: 200, body: '{"protocol":1,"docs":[', open: true });
    const stalled = await within(clientFor(page.origin, { timeoutMs: 150 }).status(), "a status body that stalls to give up on its own", 3000);
    assert.ok(!stalled.ok && stalled.kind === "unreachable" && /No answer/.test(stalled.message), "a stalled body read as an address that is something else");

    page.respond = () => ({ status: 200, body: JSON.stringify({ ...PAGE_STATUS, protocol: 2 }) });
    const other = await client.status();
    assert.ok(!other.ok && other.kind === "protocol" && /protocol 2/.test(other.message) && /speaks 1/.test(other.message), JSON.stringify(other));
  });
});
