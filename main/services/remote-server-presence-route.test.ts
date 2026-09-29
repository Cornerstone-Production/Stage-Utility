// POST /api/displays/presence, driven through RemoteServer's real request
// handler: the body the route reads reaches the video service's playback
// record. remote-server-presence.test.ts covers handlePresenceHeartbeat() with
// spies; this is the one line in the route that calls it, which a spy cannot
// see.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-presence-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");
const { callRoute } = await import("./routes/route-harness.js");
const { videoService } = await import("./video/video-service.js");
const { stageController } = await import("./stage-controller.js");

type RouteCtx = import("./routes/context.js").RouteCtx;
type Handler = { handleRequest(req: RouteCtx["req"], res: RouteCtx["res"], pathname: string, url: URL, method: string): Promise<void> };

const server = new RemoteServer() as unknown as Handler;
const handle = (c: RouteCtx) => server.handleRequest(c.req, c.res, c.pathname, c.url, c.method);

/** recordPlaybackReports() records fire-and-forget, behind a feed-store read. */
async function settle(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("a presence heartbeat's video reports reach the video service's record of that screen", async () => {
  const made = await videoService.addFeed({ name: "Presence feed", source: { kind: "external", url: "https://relay.example/whep" } });
  assert.ok(made.ok, "expected the fixture feed to be added");
  const feedId = (made as { feed: { id: string } }).feed.id;
  const outputId = stageController.getOutputs()[0]!.id;
  try {
    const r = await callRoute(handle, "/api/displays/presence", {
      method: "POST",
      body: { outputId, video: [{ feedId, via: "webrtc", decoded: 1000, dropped: 0, stalls: 0, width: 1920, height: 1080 }] },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    await settle();

    const screens = (await videoService.state()).screens;
    assert.deepEqual(
      screens.map((s) => ({ outputId: s.outputId, feedId: s.feedId, decoded: s.decodedInWindow })),
      [{ outputId, feedId, decoded: 1000 }],
      "the route must hand the heartbeat's video field to the video service",
    );
  } finally {
    await videoService.removeFeed(feedId);
  }
});
