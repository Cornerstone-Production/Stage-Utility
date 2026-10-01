// video-proxy-routes.ts, driven both ways: callRoute for a refusal (no
// networking, nothing to hold open) and a real listening server for anything
// that actually forwards bytes — the harness's fake response has no socket,
// so `req.pipe(upstream)`/`upstreamRes.pipe(res)` need a real one on both
// ends. The fake upstream stands in for MediaMTX's loopback listener; the SU
// server wraps videoProxyRoutes exactly the way remote-server.ts's real
// dispatcher does (call the module, then fall through to a 404 — see
// dispatch.test.ts for why that fall-through is the production contract,
// not a test-only shortcut).
//
// Every traversal case below is driven through a REAL socket to the real SU
// server, never through `fetch()` alone: undici normalizes a `..` segment
// client-side before the request is ever sent, so a test that only fetches
// proves the CLIENT LIBRARY normalizes, not that this server does.
// `rawGet()` below uses `http.request`'s own `path` option, which
// Node sends verbatim with no normalization of its own.

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureConsole } from "../fixtures/capture-console.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-proxy-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { videoService } = await import("../video/video-service.js");
const { videoFeedsStore } = await import("../video/feed-store.js");
const { videoProxyRoutes, proxyTimeouts, proxyOutage } = await import("./video-proxy-routes.js");
const { callRoute } = await import("./route-harness.js");
const { handlerErrorStatus } = await import("../remote-server.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");
const { PULL_START_TIMEOUT_MS } = await import("../video/reconcile-plan.js");
const { fakeRelay } = await import("../fixtures/fake-relay.js");
type SupervisorStatus = import("../video/supervisor.js").SupervisorStatus;

/** Structurally satisfies RelaySupervisorLike — an EventEmitter plus
 *  status()/version(). videoProxyRoutes never calls either method itself
 *  (routing reads videoService's published snapshot, not the live relay);
 *  this exists only so attachRelay() has something to attach. */
class FakeSupervisor extends EventEmitter {
  current: SupervisorStatus = { state: "running", since: Date.now() };
  status(): SupervisorStatus {
    return this.current;
  }
  version(): string | null {
    return "v1.21.1";
  }
}

const relay = fakeRelay();

/** Forces videoService's published snapshot to refresh — relayTarget() reads
 *  the snapshot, never the live relay, so a test that changes what the
 *  supervisor reports, or what ports a relay was attached with, has to
 *  force one of these to make relayTarget see it. Reached the same way
 *  video-service.test.ts reaches pollOnce(): the method is private, and
 *  this is the seam that already exists for it. */
const publish = () => (videoService as unknown as { publish(): Promise<void> }).publish();


// ── The fake relay MediaMTX stands in for ─────────────────────────────────

const received: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];

let upstream: http.Server;
let upstreamPort = 0;

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    received.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });

    if (req.method === "POST" && req.url === "/cam/whep") {
      res.writeHead(201, { "Content-Type": "application/sdp", Location: "/cam/whep/abc" });
      res.end("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n");
      return;
    }
    // A malformed Location the relay never actually documented sending —
    // rewriteLocation must drop it rather than forward it verbatim onto a
    // browser. A dedicated feed/path, so the well-formed /cam/whep case
    // above is untouched.
    if (req.method === "POST" && req.url === "/badloc/whep") {
      res.writeHead(201, { Location: "/badloc/whep/not a valid session!!" });
      res.end();
      return;
    }
    if (req.method === "DELETE" && req.url === "/cam/whep/abc") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/cam/whip") {
      res.writeHead(201, { Location: "/cam/whip/xyz" });
      res.end();
      return;
    }
    if (req.method === "GET" && (req.url ?? "").startsWith("/cam/index.m3u8")) {
      // Models LL-HLS's blocking playlist reload: the fixture holds the
      // request open until the next part exists.
      await new Promise((r) => setTimeout(r, 2000));
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-VERSION:9\n");
      return;
    }
    // Proves this proxy actually STREAMS rather than buffering the whole
    // upstream answer before relaying it: the fixture above proves only that
    // a HELD response eventually arrives, not that bytes already sent are not
    // held back for the rest.
    if (req.method === "GET" && req.url === "/cam/chunked.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.write("#EXTM3U\n");
      await new Promise((r) => setTimeout(r, 700));
      res.end("#EXT-X-ENDLIST\n");
      return;
    }
    if (req.method === "GET" && req.url === "/cam/seg1.m4s") {
      res.writeHead(200, { "Content-Type": "video/iso.segment" });
      res.end(Buffer.from([1, 2, 3, 4]));
      return;
    }
    // A relay dying mid-segment: headers and a first chunk go out normally,
    // then the connection is torn down with no res.end() — nothing the
    // VIEWER did, unlike the "viewer leaves mid-hold" fixture above.
    if (req.method === "GET" && req.url === "/cam/dying.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.write("#EXTM3U\n");
      setTimeout(() => res.destroy(), 50);
      return;
    }
    // MediaMTX's real HLS server does exactly this cookie-check dance on a
    // first request — headers and behaviour confirmed against the real
    // v1.21.1 binary: a plain
    // GET answers 302 to `?cookieCheck=1` with a Secure, SameSite=None,
    // Partitioned cookie; on plain HTTP (how the app is usually served)
    // a browser refuses a Secure cookie outright, so the relay ALSO
    // answers 200 straight from `?cookieCheck=1` with no cookie at all,
    // embedding a `?session=<uuid>` query on every nested URL instead —
    // confirmed directly against the real binary: `GET …?cookieCheck=1`
    // with no Cookie header answers 200, not another redirect.
    if (req.method === "GET" && (req.url ?? "").startsWith("/cam/master.m3u8")) {
      if (req.headers.cookie === "cookieCheck=1") {
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Set-Cookie": "hlsSession=abc123; HttpOnly; Secure; SameSite=None; Partitioned",
        });
        res.end("#EXTM3U\nvideo1_stream.m3u8\n");
        return;
      }
      if ((req.url ?? "").includes("cookieCheck=1")) {
        // The real binary's plain-HTTP fallback: past the redirect, no
        // cookie came back, so the session rides the query string instead.
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end("#EXTM3U\nvideo1_stream.m3u8?session=04ba6978-ca4e-474f-909b-d51d22b15cd3\n");
        return;
      }
      res.writeHead(302, {
        Location: "/cam/master.m3u8?cookieCheck=1",
        "Set-Cookie": "cookieCheck=1; HttpOnly; Secure; SameSite=None; Partitioned",
      });
      res.end();
      return;
    }
    // The sub-playlist a `?session=` query points at — proves the query
    // string itself (not just the cookie) survives this proxy unchanged.
    if (req.method === "GET" && (req.url ?? "").startsWith("/cam/video1_stream.m3u8")) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-ENDLIST\n");
      return;
    }
    // A relay that accepted the connection and then never answers — for
    // the timeout tests. Nothing here ever calls res.write/end; the PROXY
    // is what ends this connection, by destroying its own upstream request
    // once proxyTimeouts's (shrunk, for the test) window elapses.
    if ((req.url ?? "").startsWith("/hangcam/")) {
      return;
    }
    // Answers 200 for anything else under /cam/ — deliberately, not 404.
    // A traversal or malformed-segment request that
    // this module should refuse BEFORE ever building an upstream target
    // must be OBSERVABLY wrong if it leaks through — against an upstream
    // that 404s everything, a forwarding bug and a correct refusal are
    // indistinguishable (both answer 404). Against one that answers 200 for
    // anything under /cam/, only a genuine bug can produce a 200; a correct
    // refusal never reaches here at all, proven separately by asserting
    // `received.length` is unchanged.
    if ((req.url ?? "").startsWith("/cam/")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("unexpected forward reached the relay");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
});
after(() => new Promise<void>((r) => upstream.close(() => r())));

// ── A real Stage Utility server hosting only this one module ──────────────
//
// Mirrors remote-server.ts's own EARLY_ROUTE_MODULES dispatch for this one
// module: call it, and if it left the response unclaimed, answer 404 — the
// same fall-through dispatch.test.ts pins as the production contract. A
// thrown error (BodyTooLargeError, say) is mapped through the SAME
// handlerErrorStatus remote-server.ts itself uses, not a second copy of it.
// Builds `pathname` the same way remote-server.ts does — `new URL(req.url, base)`
// — which is the SERVER-side normalization the raw-traversal tests below
// are actually exercising (a raw client's un-normalized request line still
// meets this on the way in).

let su: http.Server;
let suPort = 0;

before(async () => {
  su = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      try {
        await videoProxyRoutes({ req, res, pathname: url.pathname, url, method: (req.method ?? "GET").toUpperCase() });
        if (!res.headersSent) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      } catch (err) {
        const status = handlerErrorStatus(err);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    })();
  });
  await new Promise<void>((r) => su.listen(0, "127.0.0.1", r));
  suPort = (su.address() as AddressInfo).port;
});
after(() => new Promise<void>((r) => su.close(() => r())));

function fetchSu(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${suPort}${pathname}`, init);
}

/** A GET whose request-line path is sent EXACTLY as given — no client-side
 *  URL normalization, unlike fetch(). This is what lets a traversal test
 *  actually exercise the SERVER's own `new URL()` collapse rather than
 *  proving undici's. */
function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: suPort, path: rawPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Feeds and ports, shared by every test below ────────────────────────────
//
// One push+whip feed ("cam" — whep/whip/hls all reachable through it, whip
// because its own protocol is whip), one pull feed ("lobby" — whip must
// refuse it), one push+whip feed ("hangcam" — the timeout tests' upstream
// never answers on its own paths), and one push+whip feed ("badloc" — its
// own upstream answers WHEP creation with a Location rewriteLocation must
// refuse to forward). Every feed's ports point at the ONE fake upstream
// above: real MediaMTX runs webrtcHttp and hls as two separate listeners,
// but nothing here cares which port a request lands on, only that
// relayTarget() computed the right one — video-service.test.ts covers the
// port itself being the running relay's.

let camId = "";
let lobbyId = "";
let hangId = "";
let badlocId = "";

before(async () => {
  await videoFeedsStore.update((current) => ({
    ...current,
    ports: { ...current.ports, webrtcHttp: upstreamPort, hls: upstreamPort },
  }));
  const cam = await videoService.addFeed({ name: "cam", source: { kind: "push", protocol: "whip" } });
  const lobby = await videoService.addFeed({ name: "lobby", source: { kind: "pull", url: "rtsp://192.0.2.40/s", username: "" } });
  const hang = await videoService.addFeed({ name: "hangcam", source: { kind: "push", protocol: "whip" } });
  const badloc = await videoService.addFeed({ name: "badloc", source: { kind: "push", protocol: "whip" } });
  assert.ok(cam.ok && lobby.ok && hang.ok && badloc.ok, "fixture feeds must be created for any of the tests below to mean anything");
  camId = (cam as { feed: { id: string } }).feed.id;
  lobbyId = (lobby as { feed: { id: string } }).feed.id;
  hangId = (hang as { feed: { id: string } }).feed.id;
  badlocId = (badloc as { feed: { id: string } }).feed.id;
  assert.equal(camId, "cam", "the fake upstream answers paths under /cam — the feed id must actually be that");
  assert.equal(hangId, "hangcam", "the fake upstream's never-answer path is /hangcam/ — the feed id must actually be that");
  assert.equal(badlocId, "badloc", "the fake upstream's malformed-Location path is /badloc/ — the feed id must actually be that");
});

after(async () => {
  await videoService.removeFeed(camId);
  await videoService.removeFeed(lobbyId);
  await videoService.removeFeed(badlocId);
  await videoService.removeFeed(hangId);
});

describe("relay not running", () => {
  test("503 with the exact wire shape, before the relay is ever attached", async () => {
    const res = await callRoute(videoProxyRoutes, `/video/${camId}/whep`, { method: "POST", raw: "v=0" });
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: "The video relay is not running" });
  });
});

describe("a running relay not yet reconciled", () => {
  before(async () => {
    videoService.attachRelay(relay, new FakeSupervisor(), { ...DEFAULT_VIDEO_PORTS, webrtcHttp: upstreamPort, hls: upstreamPort });
    await publish();
  });
  after(async () => {
    await videoService.detachRelay();
  });

  test("503 without reaching the relay, which would answer 400 for a path it has not been given", async () => {
    const before = received.length;
    const res = await callRoute(videoProxyRoutes, `/video/${camId}/whep`, { method: "POST", raw: "v=0" });
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: "The video relay has not been given this feed yet" });
    assert.equal(received.length, before, "nothing may reach the relay");
  });
});

describe("once the relay is attached and running", () => {
  before(async () => {
    videoService.attachRelay(relay, new FakeSupervisor(), { ...DEFAULT_VIDEO_PORTS, webrtcHttp: upstreamPort, hls: upstreamPort });
    await videoService.reconcileRelay();
    await publish();
  });
  after(async () => {
    await videoService.detachRelay();
  });

  test("POST /video/cam/whep forwards the body and Content-Type intact; the answer is 201 with a rewritten Location", async () => {
    const sdp = "v=0\r\no=- 4611 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const res = await fetchSu(`/video/${camId}/whep`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: sdp,
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("location"), `/video/${camId}/whep/abc`, "the relay-relative Location must read back as Stage Utility's own origin");
    const seen = received.at(-1)!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/cam/whep");
    assert.equal(seen.headers["content-type"], "application/sdp");
    assert.equal(seen.body.toString("utf8"), sdp, "the SDP offer must reach the relay unchanged");
  });

  test("a Location the relay answers that is not a well-formed session under this feed's own prefix is dropped, not forwarded", async () => {
    const res = await fetchSu(`/video/${badlocId}/whep`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0",
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("location"), null, `expected no Location header for a malformed one; got: ${res.headers.get("location")}`);
  });

  test("DELETE /video/cam/whep/abc reaches the upstream as DELETE /cam/whep/abc", async () => {
    const res = await fetchSu(`/video/${camId}/whep/abc`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const seen = received.at(-1)!;
    assert.equal(seen.method, "DELETE");
    assert.equal(seen.path, "/cam/whep/abc");
  });

  test("POST /video/cam/whip forwards OBS's Authorization header, and the same request against a pull feed is 404 without reaching upstream", async () => {
    const receivedCountBefore = received.length;
    const res = await fetchSu(`/video/${camId}/whip`, {
      method: "POST",
      headers: { authorization: "Bearer video:s3cret" },
    });
    assert.equal(res.status, 201);
    const seen = received.at(-1)!;
    assert.equal(seen.path, "/cam/whip");
    assert.equal(seen.headers.authorization, "Bearer video:s3cret");

    // fetchSu, not callRoute — same reasoning as the unknown-feed-id and
    // bad-filename cases below: callRoute's fake response has no `.on()`,
    // so a bug that let this fall through to forwardToUpstream() would
    // throw there rather than let the received-count assertion run.
    const refused = await fetchSu(`/video/${lobbyId}/whip`, { method: "POST" });
    assert.equal(refused.status, 404, "a pull feed has nothing listening for a WHIP offer");
    assert.equal(received.length, receivedCountBefore + 1, "the refused request must never have reached the fake relay");
  });

  test("GET /video/cam/index.m3u8?_HLS_msn=4&_HLS_part=1 keeps the query and streams the held response when it arrives", async () => {
    const startedAt = Date.now();
    const res = await fetchSu(`/video/${camId}/index.m3u8?_HLS_msn=4&_HLS_part=1`);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "#EXTM3U\n#EXT-X-VERSION:9\n");
    assert.ok(elapsedMs >= 1500, `answered in ${elapsedMs} ms — the 2 s blocking-reload hold must not have been buffered away`);
    const seen = received.at(-1)!;
    assert.equal(seen.path, "/cam/index.m3u8?_HLS_msn=4&_HLS_part=1", "the query string must reach the relay");
  });

  test("the HLS response actually streams — the client reads the first chunk before the rest arrives, not only once the whole answer is in", async () => {
    const chunks: { data: string; atMs: number }[] = [];
    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: suPort, path: `/video/${camId}/chunked.m3u8`, method: "GET" }, (res) => {
        res.on("data", (c: Buffer) => chunks.push({ data: c.toString("utf8"), atMs: Date.now() - startedAt }));
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });
    assert.ok(chunks.length >= 2, `expected the two writes to arrive as separate chunks, got ${chunks.length}`);
    assert.ok(chunks[0].data.includes("#EXTM3U"), "the first chunk must be what the fixture wrote first");
    assert.ok(chunks[0].atMs < 300, `the first chunk arrived at ${chunks[0].atMs} ms — a buffering proxy would hold it back for the full 700 ms`);
    assert.ok(chunks.at(-1)!.atMs >= 600, "the last chunk must not arrive before the fixture's own 700 ms delay");
  });

  test("GET /video/cam/seg1.m4s streams a segment", async () => {
    const res = await fetchSu(`/video/${camId}/seg1.m4s`);
    assert.equal(res.status, 200);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4]);
  });

  test("a POST to an HLS file is 405 with an Allow header, and never reaches the relay", async () => {
    const receivedCountBefore = received.length;
    const res = await fetchSu(`/video/${camId}/index.m3u8`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
    assert.equal(received.length, receivedCountBefore, "a write against a read-only playlist must never reach the relay");
  });

  test("a relay dying mid-segment (after headers) IS reported — unlike a viewer leaving, this is genuinely news about the relay", async (t) => {
    proxyOutage.forget();
    const warns = captureConsole(t, "warn");
    await assert.rejects(fetchSu(`/video/${camId}/dying.m3u8`).then((r) => r.text()));
    // Give the server side time to notice the torn-down connection and log.
    await new Promise((r) => setTimeout(r, 200));
    const relayFailureLines = warns.filter((l) => l.includes("proxy to relay failed"));
    assert.equal(relayFailureLines.length, 1, `expected exactly one relay-failure line for a relay that died mid-segment; got: ${JSON.stringify(warns)}`);
  });

  test("the relay's own cookie-check redirect and session cookie both round-trip, with the Location rewritten onto Stage Utility's origin", async () => {
    // manual: undici's default following would resolve the (correctly
    // rewritten) Location itself, hiding the one thing this test exists to
    // check — that the proxy did the rewriting, not the HTTP client.
    const redirected = await fetchSu(`/video/${camId}/master.m3u8`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    assert.equal(
      redirected.headers.get("location"),
      `/video/${camId}/master.m3u8?cookieCheck=1`,
      "a relay-relative Location must read back on Stage Utility's own origin, exactly like WHEP's",
    );
    const setCookie = redirected.headers.get("set-cookie");
    assert.ok(setCookie?.includes("cookieCheck=1"), `expected the relay's own Set-Cookie to be forwarded, got: ${setCookie}`);
    // The real binary's exact attributes — Secure means a plain-HTTP prod browser refuses to store
    // it at all, which is exactly why the query-string fallback below
    // matters more than the cookie does in production.
    assert.match(setCookie ?? "", /Secure/);
    assert.match(setCookie ?? "", /SameSite=None/);

    const followed = await fetchSu(`/video/${camId}/master.m3u8?cookieCheck=1`, { headers: { cookie: "cookieCheck=1" } });
    assert.equal(followed.status, 200, "the cookie must have reached the relay for this to succeed");
    assert.equal(await followed.text(), "#EXTM3U\nvideo1_stream.m3u8\n");
    assert.ok(followed.headers.get("set-cookie")?.includes("hlsSession="), "the relay's per-session cookie must also be forwarded");
  });

  test("on plain HTTP, where a browser refuses the Secure cookie, the relay's own query-string session survives this proxy unchanged", async () => {
    // No Cookie header at all — models a browser over plain HTTP, how the
    // app is usually served, that never stored the Secure cookie from
    // the redirect above. The real binary answers 200 straight from
    // `?cookieCheck=1` in that case, embedding `?session=<uuid>` in the
    // playlist body instead of relying on the cookie.
    const res = await fetchSu(`/video/${camId}/master.m3u8?cookieCheck=1`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /video1_stream\.m3u8\?session=/, "the session must ride the query string when no cookie came back");

    const sessionUrl = body.trim().split("\n").at(-1)!;
    const sub = await fetchSu(`/video/${camId}/${sessionUrl}`);
    assert.equal(sub.status, 200, "the ?session= query must reach the relay unchanged, the same way any other query string does");
    const seen = received.at(-1)!;
    assert.ok(seen.path.includes("?session="), `the upstream must have received the session query verbatim, got: ${seen.path}`);
  });

  test("GET /video/nope/whep is 404 — an unknown feed id, never reaching upstream", async () => {
    // fetchSu, not callRoute: callRoute's fake response has no `.on()` —
    // a bug that let this fall through to forwardToUpstream() would throw
    // there (TypeError, not a clean 404) before the received-count
    // assertion below ever ran, so callRoute could never actually observe
    // it. The real server can.
    const receivedCountBefore = received.length;
    const res = await fetchSu("/video/nope/whep");
    assert.equal(res.status, 404);
    assert.equal(received.length, receivedCountBefore);
  });

  test("a file name outside the HLS pattern is 404, claimed by this module rather than forwarded to an upstream that would otherwise answer 200", async () => {
    // fetchSu, not callRoute — same reasoning as the unknown-feed-id case
    // just above.
    const receivedCountBefore = received.length;
    const res = await fetchSu(`/video/${camId}/config.json`);
    assert.equal(res.status, 404);
    assert.equal(received.length, receivedCountBefore, "a bug that let this fall through to the relay would show up as a 200, not a 404 — see the fake upstream's own catch-all");
  });

  describe("every traversal or malformed-segment attempt is 404, and never reaches the relay", () => {
    // Each driven through a REAL socket (rawGet/fetchSu against `su`), never
    // through callRoute alone: the point is proving the SERVER refuses it,
    // and against an upstream that answers 200 for anything else under
    // /cam/ (above), a forwarding bug would show up as a 200 here, not a
    // 404 that could be confused with a correct refusal.

    test("a dot-segment traversal collapses before it ever reaches this module — the app's own 404 fallback is what answers", async () => {
      const receivedCountBefore = received.length;
      const res = await fetchSu(`/video/${camId}/../../v3/paths/list`);
      assert.equal(res.status, 404);
      assert.equal(received.length, receivedCountBefore);
    });

    test("the same traversal, sent RAW and un-normalized over the wire (fetch() would normalize it before ever sending) — the server's own URL parsing is what collapses it", async () => {
      const receivedCountBefore = received.length;
      const r = await rawGet(`/video/${camId}/../../v3/paths/list`);
      assert.equal(r.status, 404);
      assert.equal(received.length, receivedCountBefore);
    });

    test("a percent-encoded traversal as an HLS file name is 404 — HLS_FILE_PATTERN has no % in its class", async () => {
      const receivedCountBefore = received.length;
      const r = await rawGet(`/video/${camId}/..%2F..%2Fv3%2Fpaths%2Flist.m3u8`);
      assert.equal(r.status, 404);
      assert.equal(received.length, receivedCountBefore);
    });

    test("a percent-encoded traversal as a WHEP session is 404 — SESSION_PATTERN has no % or . in its class", async () => {
      const receivedCountBefore = received.length;
      const r = await rawGet(`/video/${camId}/whep/..%2F..`);
      assert.equal(r.status, 404);
      assert.equal(received.length, receivedCountBefore);
    });
  });

  test("a request body over 64 KB to WHEP is 413 and never reaches upstream", async () => {
    const receivedCountBefore = received.length;
    const oversized = "x".repeat(70 * 1024);
    let caught: unknown;
    try {
      await callRoute(videoProxyRoutes, `/video/${camId}/whep`, { method: "POST", raw: oversized });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "an over-cap body must reject rather than proceed");
    assert.equal(handlerErrorStatus(caught), 413);
    assert.equal(received.length, receivedCountBefore, "the oversized body must never have reached the fake relay");
  });

  test("demand is recorded only for a WHEP POST creating a session and a playlist GET — never a DELETE, a WHIP push, or a segment fetch", async () => {
    const isRecentlyRequested = (feedId: string) =>
      (videoService as unknown as { requestedAt: Map<string, number> }).requestedAt.has(feedId);
    const requestedAt = (videoService as unknown as { requestedAt: Map<string, number> }).requestedAt;

    requestedAt.delete(camId);
    await fetchSu(`/video/${camId}/whep/abc`, { method: "DELETE" });
    assert.equal(isRecentlyRequested(camId), false, "a session DELETE says nothing new about demand");

    requestedAt.delete(camId);
    await fetchSu(`/video/${camId}/whip`, { method: "POST" });
    assert.equal(isRecentlyRequested(camId), false, "a WHIP push is a DEVICE publishing, not a viewer watching");

    requestedAt.delete(camId);
    await fetchSu(`/video/${camId}/seg1.m4s`);
    assert.equal(isRecentlyRequested(camId), false, "a segment fetch is not what marks demand — the playlist GET already did");

    requestedAt.delete(camId);
    await fetchSu(`/video/${camId}/whep`, { method: "GET" });
    assert.equal(isRecentlyRequested(camId), false, "a session is created with POST — a GET to the same path is not that, whatever it otherwise does");

    requestedAt.delete(camId);
    await fetchSu(`/video/${camId}/index.m3u8`, { method: "POST" });
    assert.equal(isRecentlyRequested(camId), false, "a playlist is read with GET — a POST to the same path is not a viewer watching");

    requestedAt.delete(camId);
    await fetchSu(`/video/${camId}/whep`, { method: "POST", headers: { "content-type": "application/sdp" }, body: "v=0" });
    assert.equal(isRecentlyRequested(camId), true, "a WHEP POST creating a session IS a viewer asking to watch");

    requestedAt.delete(camId);
    await fetchSu(`/video/${camId}/index.m3u8`);
    assert.equal(isRecentlyRequested(camId), true, "a playlist GET IS a viewer asking to watch");
  });

  test("demand is recorded AFTER the body-size check — an over-cap WHEP POST never marks it", async () => {
    const requestedAt = (videoService as unknown as { requestedAt: Map<string, number> }).requestedAt;
    requestedAt.delete(camId);
    const oversized = "x".repeat(70 * 1024);
    await assert.rejects(() => callRoute(videoProxyRoutes, `/video/${camId}/whep`, { method: "POST", raw: oversized }));
    assert.equal(requestedAt.has(camId), false, "a body over the cap must reject before demand is ever recorded");
  });
});

describe("a viewer leaving mid-hold", () => {
  before(async () => {
    videoService.attachRelay(relay, new FakeSupervisor(), { ...DEFAULT_VIDEO_PORTS, webrtcHttp: upstreamPort, hls: upstreamPort });
    await videoService.reconcileRelay();
    await publish();
    proxyOutage.forget();
  });
  after(async () => {
    await videoService.detachRelay();
  });

  test("aborting a held HLS request logs no relay-failure line — the viewer left, the relay did not fail", async (t) => {
    // AbortController, not a raw http.request destroy(): this is what an
    // actual browser navigating away mid-hold does. (A raw client would
    // work too, PROVIDED it calls .end() first — Node sends nothing on the
    // wire before .end()/.write(), so a request destroyed without one
    // never reaches the server at all; the first draft of this test forgot
    // that and chased a false lead. fetch() has no such trap.)
    const warns = captureConsole(t, "warn");
    const controller = new AbortController();
    const fetchPromise = fetchSu(`/video/${camId}/index.m3u8`, { signal: controller.signal });
    // The fixture holds for 2 s before answering; abort well inside that window.
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(fetchPromise);
    // Give the server side time to notice the close and run its own
    // cleanup (clientGone, upstreamReq.destroy()) before asserting.
    await new Promise((r) => setTimeout(r, 300));
    const relayFailureLines = warns.filter((l) => l.includes("proxy to relay failed"));
    assert.deepEqual(relayFailureLines, [], `expected no relay-failure warning for a viewer that left; got: ${JSON.stringify(warns)}`);
  });
});

describe("an unreachable relay", () => {
  let deadPort = 0;

  before(async () => {
    // A port nothing listens on: bind, note the port, close — guaranteed
    // free and guaranteed to refuse the next connection.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    videoService.attachRelay(relay, new FakeSupervisor(), { ...DEFAULT_VIDEO_PORTS, webrtcHttp: deadPort, hls: deadPort });
    await videoService.reconcileRelay();
    await publish();
    proxyOutage.forget();
  });
  after(async () => {
    await videoService.detachRelay();
  });

  test("a connection refused before any header is a 502 carrying the message", async () => {
    const res = await fetchSu(`/video/${camId}/whep`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0",
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /ECONNREFUSED|connect/i, `expected a connection-refused message, got: ${body.error}`);
  });

  test("two consecutive failures against the same feed log exactly one relay-failure line — one per outage, not one per request", async (t) => {
    proxyOutage.forget();
    const warns = captureConsole(t, "warn");
    await fetchSu(`/video/${camId}/whep`, { method: "POST", headers: { "content-type": "application/sdp" }, body: "v=0" });
    await fetchSu(`/video/${camId}/whep`, { method: "POST", headers: { "content-type": "application/sdp" }, body: "v=0" });
    const relayFailureLines = warns.filter((l) => l.includes("proxy to relay failed"));
    assert.equal(relayFailureLines.length, 1, `expected exactly one line for two failures of the same outage; got: ${JSON.stringify(relayFailureLines)}`);
  });

  test("recovery logs once, after settling, once the relay answers again", async (t) => {
    proxyOutage.forget();
    proxyOutage.settleAfter(1); // the default is 2 minutes; this test cannot wait that long
    try {
      await fetchSu(`/video/${camId}/whep`, { method: "POST", headers: { "content-type": "application/sdp" }, body: "v=0" }); // one failure, opens the outage

      // Point back at the real fake upstream — the relay "answering again".
      videoService.attachRelay(relay, new FakeSupervisor(), { ...DEFAULT_VIDEO_PORTS, webrtcHttp: upstreamPort, hls: upstreamPort });
      await videoService.reconcileRelay();
      await publish();
      await new Promise((r) => setTimeout(r, 20)); // past the 1 ms settle window

      const logs = captureConsole(t, "log");
      await fetchSu(`/video/${camId}/whep`, { method: "POST", headers: { "content-type": "application/sdp" }, body: "v=0" });
      const recoveryLines = logs.filter((l) => l.includes("is answering again"));
      assert.equal(recoveryLines.length, 1, `expected exactly one recovery line; got: ${JSON.stringify(logs)}`);
    } finally {
      proxyOutage.settleAfter(2 * 60 * 1000); // restore the real default
    }
  });
});

describe("a relay that never answers", () => {
  before(async () => {
    videoService.attachRelay(relay, new FakeSupervisor(), { ...DEFAULT_VIDEO_PORTS, webrtcHttp: upstreamPort, hls: upstreamPort });
    await videoService.reconcileRelay();
    await publish();
  });
  after(async () => {
    await videoService.detachRelay();
  });

  test("a WHEP offer outlasts the relay's own dial window, so the relay's reason reaches the screen", () => {
    // Seen on a dev server, 1 Oct 2026: a pull feed pointed at the wrong
    // device. The relay answered 400 "source of path 'box' has timed out" at
    // 10.0 s; the proxy, on the same 10 s, answered 502 "the video relay did
    // not answer in time" instead.
    assert.ok(
      proxyTimeouts.whepWhip > PULL_START_TIMEOUT_MS,
      `whepWhip ${proxyTimeouts.whepWhip} ms must be longer than the relay's ${PULL_START_TIMEOUT_MS} ms dial`,
    );
  });

  test("a WHEP/WHIP request against a relay that never answers is a 502 once proxyTimeouts.whepWhip elapses", async () => {
    const real = proxyTimeouts.whepWhip;
    proxyTimeouts.whepWhip = 150;
    try {
      const startedAt = Date.now();
      const res = await fetchSu(`/video/${hangId}/whep`, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: "v=0",
      });
      const elapsedMs = Date.now() - startedAt;
      assert.equal(res.status, 502);
      assert.ok(elapsedMs < 2000, `took ${elapsedMs} ms — the shrunk 150 ms timeout was not actually applied`);
    } finally {
      proxyTimeouts.whepWhip = real;
    }
  });

  test("an HLS request against a relay that never answers is a 502 once proxyTimeouts.hls elapses", async () => {
    const real = proxyTimeouts.hls;
    proxyTimeouts.hls = 150;
    try {
      const startedAt = Date.now();
      const res = await fetchSu(`/video/${hangId}/index.m3u8`);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(res.status, 502);
      assert.ok(elapsedMs < 2000, `took ${elapsedMs} ms — the shrunk 150 ms timeout was not actually applied`);
    } finally {
      proxyTimeouts.hls = real;
    }
  });
});
