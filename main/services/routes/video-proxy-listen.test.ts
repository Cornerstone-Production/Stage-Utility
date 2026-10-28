// The playback proxy and a feed's `<id>-listen` relay path: the one place a
// browser can reach it. Driven through the real route handler on a real socket,
// against a fake relay listener, with feeds whose audio status the real video
// service settles from what the fake relay reports.

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FakeSupervisor } from "../fixtures/fake-supervisor.js";
import { within } from "../fixtures/within.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-proxy-listen-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { videoService, videoPollDeps } = await import("../video/video-service.js");
const { videoProxyRoutes, proxyOutage } = await import("./video-proxy-routes.js");
const { captureConsole } = await import("../fixtures/capture-console.js");
const { fakeRelay } = await import("../fixtures/fake-relay.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");
const { videoFeedsStore } = await import("../video/feed-store.js");
type RelayPath = import("../video/relay.js").RelayPath;
type FfmpegFinder = import("../video/ffmpeg-system.js").FfmpegFinder;

const received: { method: string; path: string }[] = [];
let upstream: http.Server;
let upstreamPort = 0;
let su: http.Server;
let suPort = 0;
/** While set, the relay drops the connection on the converted feed's listening path. */
let breakListen = false;

before(async () => {
  upstream = http.createServer((req, res) => {
    received.push({ method: req.method ?? "", path: req.url ?? "" });
    req.resume();
    if (breakListen && req.url === "/aac-listen/whep") {
      req.socket.destroy();
      return;
    }
    const m = /^\/([a-z0-9-]+)\/whep$/.exec(req.url ?? "");
    if (req.method === "POST" && m) {
      res.writeHead(201, { "Content-Type": "application/sdp", Location: `/${m[1]}/whep/abc` });
      res.end("v=0\r\n");
      return;
    }
    // Anything else answers 200, so a request that leaks through is a visible bug
    // and not an indistinguishable 404.
    res.writeHead(200);
    res.end("reached the relay");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  su = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      await videoProxyRoutes({ req, res, pathname: url.pathname, url, method: (req.method ?? "GET").toUpperCase() });
      if (!res.headersSent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    })();
  });
  await new Promise<void>((r) => su.listen(0, "127.0.0.1", r));
  suPort = (su.address() as AddressInfo).port;
});
after(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => su.close(() => r()));
});

const post = (pathname: string) => fetch(`http://127.0.0.1:${suPort}${pathname}`, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: "v=0" });
const get = (pathname: string) => fetch(`http://127.0.0.1:${suPort}${pathname}`);

const ready = (name: string, audio: string | null): RelayPath => ({
  name,
  ready: true,
  readyTime: "2026-10-22T00:00:00Z",
  source: { type: "rtspSource", id: "s" },
  video: { codec: "H264", width: 1920, height: 1080, profile: "High" },
  audio,
  readers: 0,
});

const FFMPEG_OK = { ok: true, path: "/usr/bin/ffmpeg", resolvedPath: "/usr/bin/ffmpeg", version: "7.1", source: "automatic" } as const;
const FFMPEG_MISSING = { ok: false, reason: "ffmpeg is not installed on this server", detail: "", hint: "" } as const;
const finder = (answer: typeof FFMPEG_OK | typeof FFMPEG_MISSING): FfmpegFinder => ({ find: async () => answer, reset() {} });

const poll = () => (videoService as unknown as { pollOnce(): Promise<void> }).pollOnce();
const settle = async () => {
  await within(videoService.whenPollsIdle(), "polls to finish");
  await poll();
  await within(videoService.whenPollsIdle(), "polls to finish");
  await within(videoService.whenBackgroundIdle(), "background work to finish");
  await within(videoService.whenPollsIdle(), "polls to finish");
};

const realInDemand = videoPollDeps.inDemand;
const ids: Record<string, string> = {};

async function attach(ffmpeg: typeof FFMPEG_OK | typeof FFMPEG_MISSING): Promise<void> {
  videoService.useFfmpegFinder(finder(ffmpeg));
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(
    fakeRelay({
      status: async () => [ready(ids.aac!, "MPEG-4 Audio"), ready(ids.opus!, "Opus"), ready(ids.silent!, null), ready(ids.pass!, "G711")],
    }),
    new FakeSupervisor() as never,
    { ...DEFAULT_VIDEO_PORTS, webrtcHttp: upstreamPort, hls: upstreamPort },
    { on: true },
  );
  await videoService.reconcileRelay();
  await settle();
}

before(async () => {
  for (const name of ["Aac", "Opus", "Silent", "Pass"]) {
    const made = await videoService.addFeed({
      name,
      source: { kind: "pull", url: "rtsp://192.0.2.10/s", username: "" },
      ...(name === "Pass" ? { audioSourceUrl: "http://192.0.2.28/0.ts" } : {}),
    });
    assert.ok(made.ok, JSON.stringify(made));
    ids[name.toLowerCase()] = made.feed.id;
  }
  assert.deepEqual(ids, { aac: "aac", opus: "opus", silent: "silent", pass: "pass" });
});
after(async () => {
  videoPollDeps.inDemand = realInDemand;
  await videoService.detachRelay();
  for (const id of Object.values(ids)) await videoService.removeFeed(id);
});

describe("with ffmpeg available", () => {
  before(() => attach(FFMPEG_OK));
  after(() => videoService.detachRelay());

  test("the statuses this suite relies on are what the service reports", async () => {
    const audio = Object.fromEntries((await videoService.state()).feeds.map((f) => [f.id, f.audio]));
    assert.deepEqual(audio.aac, { state: "converted", listenPath: "aac-listen" });
    assert.deepEqual(audio.pass, { state: "pass-through", listenPath: "pass-listen" });
    assert.deepEqual(audio.opus, { state: "direct", listenPath: "opus" });
    assert.deepEqual(audio.silent, { state: "none" });
  });

  test("a converted feed's -listen path is forwarded to the relay, and its Location comes back on the same path", async () => {
    received.length = 0;
    const res = await post("/video/aac-listen/whep");
    assert.equal(res.status, 201);
    assert.deepEqual(received, [{ method: "POST", path: "/aac-listen/whep" }]);
    assert.equal(res.headers.get("location"), "/video/aac-listen/whep/abc");
  });

  test("a pass-through feed's -listen path is forwarded too", async () => {
    received.length = 0;
    assert.equal((await post("/video/pass-listen/whep")).status, 201);
    assert.deepEqual(received, [{ method: "POST", path: "/pass-listen/whep" }]);
  });

  test("a session is ended on the same path it was made on", async () => {
    received.length = 0;
    const res = await fetch(`http://127.0.0.1:${suPort}/video/aac-listen/whep/abc`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(received, [{ method: "DELETE", path: "/aac-listen/whep/abc" }]);
  });

  test("a feed that is read directly, has no audio, or does not exist has no -listen path to reach", async () => {
    received.length = 0;
    for (const id of ["opus-listen", "silent-listen", "ghost-listen"]) {
      assert.equal((await post(`/video/${id}/whep`)).status, 404, id);
    }
    assert.deepEqual(received, [], "a refused path reached the relay");
  });

  test("only WHEP reads a -listen path: not WHIP, HLS or a playlist", async () => {
    received.length = 0;
    assert.equal((await post("/video/aac-listen/whip")).status, 404);
    assert.equal((await get("/video/aac-listen/index.m3u8")).status, 404);
    assert.equal((await get("/video/aac-listen/seg0.m4s")).status, 404);
    assert.deepEqual(received, []);
  });

  test("nothing else of that shape is reachable: another feed's path, a doubled suffix, a bare suffix, other cases", async () => {
    received.length = 0;
    for (const id of ["aac-listen-listen", "-listen", "listen", "Aac-listen", "aac-LISTEN", "aac-listen-", "aac--listen"]) {
      const res = await post(`/video/${id}/whep`);
      assert.ok(res.status === 404, `${id} answered ${res.status}`);
    }
    assert.deepEqual(received, []);
  });

  test("a stored legacy feed whose own id ends in -listen is not answered as another feed's audio", async () => {
    await videoFeedsStore.update((c) => ({
      ...c,
      feeds: [...c.feeds, { id: "aac-listen", name: "Legacy", source: { kind: "pull", url: "rtsp://192.0.2.50/s", username: "" } }],
    }));
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    try {
      assert.ok((await videoService.state()).feeds.some((f) => f.id === "aac-listen"), "the legacy feed never reached the snapshot, so this proves nothing");
      received.length = 0;
      assert.equal((await post("/video/aac-listen/whep")).status, 404);
      assert.deepEqual(received, []);
    } finally {
      await videoFeedsStore.update((c) => ({ ...c, feeds: c.feeds.filter((f) => f.id !== "aac-listen") }));
      await (videoService as unknown as { publish(): Promise<void> }).publish();
    }
    assert.equal((await post("/video/aac-listen/whep")).status, 201, "the converted feed's path stopped answering after the legacy feed went");
  });

  test("a status that names another path than the one asked for is not served", async () => {
    const snap = (videoService as unknown as { snapshot: { feeds: { id: string; audio?: unknown }[] } }).snapshot;
    const feed = snap.feeds.find((f) => f.id === "aac")!;
    const real = feed.audio;
    feed.audio = { state: "converted", listenPath: "elsewhere-listen" };
    try {
      received.length = 0;
      assert.equal((await post("/video/aac-listen/whep")).status, 404);
      assert.deepEqual(received, []);
    } finally {
      feed.audio = real;
    }
  });

  test("a failure reaching a -listen path is logged under its feed, never under the -listen id", async (t) => {
    proxyOutage.forget();
    const warns = captureConsole(t, "warn");
    breakListen = true;
    try {
      assert.equal((await post("/video/aac-listen/whep")).status, 502);
    } finally {
      breakListen = false;
      proxyOutage.forget();
    }
    assert.equal(warns.length, 1, JSON.stringify(warns));
    assert.match(warns[0]!, /proxy to relay failed for aac:/);
    assert.ok(!warns[0]!.includes("aac-listen"), "the outage was keyed by the listen path");
  });

  test("a listener's request counts as demand for the feed itself, not for a key of its own", () => {
    const requested = (videoService as unknown as { requestedAt: Map<string, number> }).requestedAt;
    assert.ok(requested.has("aac"), "the feed was not marked requested");
    assert.ok(requested.has("pass"));
    assert.equal(requested.has("aac-listen"), false);
    assert.equal(requested.has("pass-listen"), false);
  });
});

describe("without a usable ffmpeg", () => {
  before(() => attach(FFMPEG_MISSING));
  after(() => videoService.detachRelay());

  test("a feed whose converter cannot run has no -listen path to reach", async () => {
    assert.equal((await videoService.state()).feeds.find((f) => f.id === "aac")?.audio?.state, "unavailable");
    received.length = 0;
    assert.equal((await post("/video/aac-listen/whep")).status, 404);
    assert.deepEqual(received, []);
  });
});
