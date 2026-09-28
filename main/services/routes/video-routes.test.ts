import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { callRoute } = await import("./route-harness.js");
const { videoRoutes } = await import("./video-routes.js");

const EMBED = { name: "Online stream", source: { kind: "embed", player: "youtube-video", ref: "dQw4w9WgXcQ" } };

test("create, list, rename, delete", async () => {
  const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: EMBED });
  assert.equal(made.status, 201);
  const feed = (made.json as { feed: { id: string; play: { via: string; src: string } } }).feed;
  assert.equal(feed.id, "online-stream");
  assert.equal(feed.play.via, "embed");
  assert.match(feed.play.src, /mute=1/);

  const renamed = await callRoute(videoRoutes, "/api/video/feeds/online-stream", { method: "PATCH", body: { name: "Lobby" } });
  assert.equal((renamed.json as { feed: { id: string; name: string } }).feed.id, "online-stream", "the id never changes");

  const state = await callRoute(videoRoutes, "/api/video/state");
  const s = state.json as { rev: number; relay: { state: string }; feeds: { name: string; status: { state: string } }[] };
  assert.equal(s.relay.state, "off");
  assert.deepEqual(s.feeds.map((f) => [f.name, f.status.state]), [["Lobby", "embed"]]);

  assert.equal((await callRoute(videoRoutes, "/api/video/feeds/online-stream", { method: "DELETE" })).status, 200);
  assert.equal((await callRoute(videoRoutes, "/api/video/feeds/online-stream", { method: "DELETE" })).status, 404);
});

test("a refused body says why, with 400", async () => {
  const r = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "X", source: { kind: "external", url: "ftp://h" } } });
  assert.equal(r.status, 400);
  assert.ok((r.json as { error: string }).error.length > 0);
});

test("an id outside the pattern is 404, not a lookup", async () => {
  // ".." is deliberately absent from this list: `new URL()` (built the same way
  // in production — see remote-server.ts) strips a dot-segment out of the path
  // before any route sees it, encoded or not, so the literal string ".." can
  // never reach this handler at all. Confirmed: new URL("/api/video/feeds/..")
  // and new URL("/api/video/feeds/%2e%2e") both resolve to "/api/video/". That
  // makes it a fact about the URL parser, true for every route in the app, not
  // something FEED_ID_PATTERN has to guard — and callRoute() only drives this
  // one module, with no 404 fallback for a path nothing here matches, so
  // asserting 404 for it here fails on a request the real server never forms.
  for (const id of ["__proto__", "constructor", "A"]) {
    const r = await callRoute(videoRoutes, `/api/video/feeds/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: "x" } });
    assert.equal(r.status, 404, id);
  }
});

test("__proto__ and constructor are refused as DELETE and PATCH targets, and change nothing", async () => {
  const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: EMBED });
  assert.equal(made.status, 201);
  const before = (await callRoute(videoRoutes, "/api/video/state")).json;

  for (const id of ["__proto__", "constructor"]) {
    const patched = await callRoute(videoRoutes, `/api/video/feeds/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: "x" } });
    assert.equal(patched.status, 404, `PATCH ${id}`);
    const deleted = await callRoute(videoRoutes, `/api/video/feeds/${encodeURIComponent(id)}`, { method: "DELETE" });
    assert.equal(deleted.status, 404, `DELETE ${id}`);
  }

  const after = (await callRoute(videoRoutes, "/api/video/state")).json;
  assert.deepEqual(after, before, "neither refused id ever touched the feed list");

  assert.equal((await callRoute(videoRoutes, "/api/video/feeds/online-stream", { method: "DELETE" })).status, 200);
});

test("usage names the layouts that place the feed, inside containers too", async () => {
  const box = { x: 0, y: 0, w: 1, h: 1 };
  await fs.writeFile(
    path.join(TMP, "views.json"),
    JSON.stringify([
      {
        id: "v1", name: "Stage confidence", kind: "custom", createdAt: "2026-09-27T00:00:00.000Z",
        layout: {
          version: 1, canvas: { w: 1920, h: 1080 },
          objects: [{ id: "c1", ...box, config: { type: "container" },
            children: [{ id: "o1", ...box, config: { type: "video", feedId: "cam" } }] }],
        },
      },
      { id: "v2", name: "Unrelated", kind: "custom", createdAt: "2026-09-27T00:00:00.000Z",
        layout: { version: 1, canvas: { w: 1920, h: 1080 }, objects: [] } },
    ]),
  );
  const { viewsStore } = await import("../views-store.js");
  await viewsStore.reload();
  await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "Cam", source: { kind: "external", url: "http://h/cam/whep" } } });
  const r = await callRoute(videoRoutes, "/api/video/feeds/cam/usage");
  assert.deepEqual(r.json, { layouts: [{ viewId: "v1", name: "Stage confidence" }] });
});

/** Offers every kind for the duration of `fn`: this build offers only embed
 *  and external, and a password only exists for pull. */
async function withAllKinds<T>(fn: () => Promise<T>): Promise<T> {
  const { videoService } = await import("../video/video-service.js");
  const svc = videoService as unknown as { allowedKinds: () => ReadonlySet<string> };
  svc.allowedKinds = () => new Set(["pull", "push", "embed", "external"]);
  try {
    return await fn();
  } finally {
    delete (svc as { allowedKinds?: unknown }).allowedKinds;
  }
}

test("a PATCH's password reaches the feed's secrets slot", async () => {
  const { secretsStore } = await import("../secrets.js");
  await withAllKinds(async () => {
    const made = await callRoute(videoRoutes, "/api/video/feeds", {
      method: "POST",
      body: { name: "Pulpit cam", source: { kind: "pull", url: "rtsp://192.0.2.40:8554/s", username: "admin" } },
    });
    assert.equal(made.status, 201);
    const id = (made.json as { feed: { id: string } }).feed.id;

    const patched = await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "PATCH", body: { password: "new-password" } });
    assert.equal(patched.status, 200);
    assert.equal((await secretsStore.getSecrets(`video:${id}`)).password, "new-password", "the PATCH's password was dropped");

    assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" })).status, 200);
  });
});

test("a PATCH carrying a source replaces it, and keeps the name", async () => {
  const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "Foyer", source: EMBED.source } });
  const id = (made.json as { feed: { id: string } }).feed.id;
  const patched = await callRoute(videoRoutes, `/api/video/feeds/${id}`, {
    method: "PATCH",
    body: { source: { kind: "external", url: "http://192.0.2.50/foyer/index.m3u8" } },
  });
  assert.equal(patched.status, 200);
  const feed = (patched.json as { feed: { name: string; source: { kind: string } } }).feed;
  assert.deepEqual([feed.name, feed.source.kind], ["Foyer", "external"]);
  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" })).status, 200);
});
