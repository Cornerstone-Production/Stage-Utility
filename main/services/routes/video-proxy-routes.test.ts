// video-proxy-routes.ts, driven both ways: callRoute for a refusal (no
// networking, nothing to hold open) and a real listening server for anything
// that actually forwards bytes — the harness's fake response has no socket,
// so `req.pipe(upstream)`/`upstreamRes.pipe(res)` need a real one on both
// ends. The fake upstream stands in for MediaMTX's loopback listener; the SU
// server wraps videoProxyRoutes exactly the way remote-server.ts's real
// dispatcher does (call the module, then fall through to a 404 — see
// dispatch.test.ts for why that fall-through is the production contract,
// not a test-only shortcut).

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-proxy-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { videoService } = await import("../video/video-service.js");
const { videoFeedsStore } = await import("../video/feed-store.js");
const { withAllKinds } = await import("../fixtures/video-kinds.js");
const { videoProxyRoutes } = await import("./video-proxy-routes.js");
const { callRoute } = await import("./route-harness.js");
const { handlerErrorStatus } = await import("../remote-server.js");
type SupervisorStatus = import("../video/supervisor.js").SupervisorStatus;
type VideoRelay = import("../video/relay.js").VideoRelay;

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

const fakeRelay: VideoRelay = {
  reconcile: async () => {},
  status: async () => [],
  playback: (feedId: string) => ({ whep: `/video/${feedId}/whep`, hls: `/video/${feedId}/index.m3u8` }),
  kickPublisher: async () => {},
};

/** Forces videoService's published snapshot to refresh — relayTarget() reads
 *  the snapshot, never the live relay, so a test that changes what the
 *  supervisor reports has to force one of these to make relayTarget see it.
 *  Reached the same way video-service.test.ts reaches pollOnce(): the
 *  method is private, and this is the seam that already exists for it. */
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
      // request open until the next part exists (task-13-brief.md).
      await new Promise((r) => setTimeout(r, 2000));
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-VERSION:9\n");
      return;
    }
    if (req.method === "GET" && req.url === "/cam/seg1.m4s") {
      res.writeHead(200, { "Content-Type": "video/iso.segment" });
      res.end(Buffer.from([1, 2, 3, 4]));
      return;
    }
    // MediaMTX's real HLS server does exactly this cookie-check dance on a
    // first request — undocumented anywhere until driving the real v1.21.1
    // binary hit it (task-13-report.md). Modelled here, distinct from the
    // /cam/index.m3u8 fixture above, so that one test does not have to carry
    // both the blocking-reload hold AND the cookie round trip at once.
    if (req.method === "GET" && (req.url ?? "").startsWith("/cam/master.m3u8")) {
      if (req.headers.cookie === "cookieCheck=1") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Set-Cookie": "hlsSession=abc123; HttpOnly" });
        res.end("#EXTM3U\nvideo1_stream.m3u8\n");
        return;
      }
      res.writeHead(302, { Location: "/cam/master.m3u8?cookieCheck=1", "Set-Cookie": "cookieCheck=1; HttpOnly" });
      res.end();
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

// ── Feeds and ports, shared by every test below ────────────────────────────
//
// One push+whip feed ("cam" — whep/whip/hls all reachable through it, whip
// because its own protocol is whip) and one pull feed ("lobby" — whip must
// refuse it, whep/hls would work but nothing here exercises that a second
// time). Both webrtcHttp and hls point at the ONE fake upstream above: real
// MediaMTX runs them as two separate listeners, but nothing here cares which
// port a request lands on, only that relayTarget() computed the right one.

let camId = "";
let lobbyId = "";

before(async () => {
  await videoFeedsStore.update((current) => ({
    ...current,
    ports: { ...current.ports, webrtcHttp: upstreamPort, hls: upstreamPort },
  }));
  const cam = await withAllKinds(() => videoService.addFeed({ name: "cam", source: { kind: "push", protocol: "whip" } }));
  const lobby = await withAllKinds(() => videoService.addFeed({ name: "lobby", source: { kind: "pull", url: "rtsp://192.0.2.40/s", username: "" } }));
  assert.ok(cam.ok && lobby.ok, "fixture feeds must be created for any of the tests below to mean anything");
  camId = (cam as { feed: { id: string } }).feed.id;
  lobbyId = (lobby as { feed: { id: string } }).feed.id;
  assert.equal(camId, "cam", "the fake upstream answers paths under /cam — the feed id must actually be that");
});

after(async () => {
  await videoService.removeFeed(camId);
  await videoService.removeFeed(lobbyId);
});

describe("relay not running", () => {
  test("503 with the exact wire shape, before the relay is ever attached", async () => {
    const res = await callRoute(videoProxyRoutes, `/video/${camId}/whep`, { method: "POST", raw: "v=0" });
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: "The video relay is not running" });
  });
});

describe("once the relay is attached and running", () => {
  before(async () => {
    videoService.attachRelay(fakeRelay, new FakeSupervisor());
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

    const refused = await callRoute(videoProxyRoutes, `/video/${lobbyId}/whip`, { method: "POST" });
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

  test("GET /video/cam/seg1.m4s streams a segment", async () => {
    const res = await fetchSu(`/video/${camId}/seg1.m4s`);
    assert.equal(res.status, 200);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4]);
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

    const followed = await fetchSu(`/video/${camId}/master.m3u8?cookieCheck=1`, { headers: { cookie: "cookieCheck=1" } });
    assert.equal(followed.status, 200, "the cookie must have reached the relay for this to succeed");
    assert.equal(await followed.text(), "#EXTM3U\nvideo1_stream.m3u8\n");
    assert.ok(followed.headers.get("set-cookie")?.includes("hlsSession="), "the relay's per-session cookie must also be forwarded");
  });

  test("GET /video/nope/whep is 404 — an unknown feed id", async () => {
    const res = await callRoute(videoProxyRoutes, "/video/nope/whep");
    assert.equal(res.status, 404);
  });

  test("a file name outside the HLS pattern is 404, claimed by this module rather than falling through to the SPA shell", async () => {
    const res = await callRoute(videoProxyRoutes, `/video/${camId}/config.json`);
    assert.equal(res.status, 404);
  });

  test("a dot-segment traversal never reaches this module at all — proven through the real dispatch, where it is what answers 404", async () => {
    // callRoute cannot observe this one: the WHATWG URL parser that builds
    // `pathname` collapses the `..` before any router ever sees it, so
    // `/video/cam/../../v3/paths/list` arrives here as `/v3/paths/list` —
    // outside this module's territory by construction (parseRequest's own
    // "unclaimed" branch, exercised above by the plain 404 cases). What a
    // browser actually gets therefore depends on the REST of the dispatch
    // chain, which is what this drives.
    const res = await fetchSu(`/video/${camId}/../../v3/paths/list`);
    assert.equal(res.status, 404);
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
});
