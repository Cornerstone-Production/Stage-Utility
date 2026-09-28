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

test("a PATCH's password reaches the feed's secrets slot", async () => {
  const { secretsStore } = await import("../secrets.js");
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

test("a push feed's password lives only in secretsStore — never in the feed file, /api/video/state or its broadcast — and the address routes carry it", async () => {
  const { secretsStore } = await import("../secrets.js");
  const { addBroadcastListener } = await import("../broadcaster.js");
  const frames: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "video:state") frames.push(payload);
  });

  const made = await callRoute(videoRoutes, "/api/video/feeds", {
    method: "POST",
    body: { name: "Stage box", source: { kind: "push", protocol: "srt" } },
  });
  assert.equal(made.status, 201);
  const id = (made.json as { feed: { id: string } }).feed.id;

  const secret = (await secretsStore.getSecrets(`video:${id}`)).password;
  assert.equal(typeof secret, "string", "expected addFeed to mint a push password");
  assert.equal(secret!.length, 16, "expected a 16-character password");

  // The feed file on disk — read raw, not through the store's own API, so a
  // password folded into `source` or a sibling field would still be caught.
  const raw = await fs.readFile(path.join(TMP, "video-feeds.json"), "utf-8");
  assert.equal(raw.includes(secret!), false, "the feed file must never carry the password");

  const state = await callRoute(videoRoutes, "/api/video/state");
  assert.equal(JSON.stringify(state.json).includes(secret!), false, "GET /api/video/state must never carry the password");
  assert.equal(
    frames.some((f) => JSON.stringify(f).includes(secret!)),
    false,
    "the video:state broadcast must never carry the password",
  );

  const address = await callRoute(videoRoutes, `/api/video/feeds/${id}/push`);
  assert.equal(address.status, 200);
  const addrBody = address.json as { protocol: string; address: string; password: string };
  assert.equal(addrBody.protocol, "srt");
  assert.equal(addrBody.password, secret);
  assert.ok(addrBody.address.includes(secret!), "expected the SRT address to carry the password in its streamid");

  const rotated = await callRoute(videoRoutes, `/api/video/feeds/${id}/push/new-password`, { method: "POST" });
  assert.equal(rotated.status, 200);
  const rotatedBody = rotated.json as { password: string };
  assert.notEqual(rotatedBody.password, secret, "expected new-password to mint a different password");
  assert.equal((await secretsStore.getSecrets(`video:${id}`)).password, rotatedBody.password);

  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(await secretsStore.getSecrets(`video:${id}`), {}, "delete must clear the push feed's secret slot");
});

test("GET and POST /push routes 404 for a feed that is not push, or does not exist", async () => {
  const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: EMBED });
  assert.equal(made.status, 201);
  const id = (made.json as { feed: { id: string } }).feed.id;

  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${id}/push`)).status, 404, "an embed feed has no push address");
  assert.equal(
    (await callRoute(videoRoutes, `/api/video/feeds/${id}/push/new-password`, { method: "POST" })).status,
    404,
  );
  assert.equal((await callRoute(videoRoutes, "/api/video/feeds/nonexistent/push")).status, 404);

  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" })).status, 200);
});

test("a pull feed's password lives only in secretsStore — never in the feed file — and an empty-string PATCH clears it", async () => {
  const { secretsStore } = await import("../secrets.js");
  const made = await callRoute(videoRoutes, "/api/video/feeds", {
    method: "POST",
    body: { name: "Balcony cam", source: { kind: "pull", url: "rtsp://192.0.2.41:8554/s", username: "admin" }, password: "s3cret!" },
  });
  assert.equal(made.status, 201);
  const id = (made.json as { feed: { id: string } }).feed.id;
  assert.equal((await secretsStore.getSecrets(`video:${id}`)).password, "s3cret!");

  const raw = await fs.readFile(path.join(TMP, "video-feeds.json"), "utf-8");
  assert.equal(raw.includes("s3cret!"), false, "the feed file must never carry the password");

  const cleared = await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "PATCH", body: { password: "" } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(
    await secretsStore.getSecrets(`video:${id}`),
    {},
    'an update carrying password: "" must clear the stored password, not leave it in place',
  );

  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" })).status, 200);
});

test("changing a feed's kind moves its secret correctly: push clears on -> external, pull gets nothing carried over from a former push, embed/external never touch secrets", async () => {
  const { secretsStore } = await import("../secrets.js");

  // push -> external: the push password must not survive under the new kind.
  const push = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "PTZ", source: { kind: "push", protocol: "rtmp" } } });
  const pushId = (push.json as { feed: { id: string } }).feed.id;
  assert.ok((await secretsStore.getSecrets(`video:${pushId}`)).password, "expected a push password at creation");
  await callRoute(videoRoutes, `/api/video/feeds/${pushId}`, {
    method: "PATCH",
    body: { source: { kind: "external", url: "http://192.0.2.80/cam/whep" } },
  });
  assert.deepEqual(await secretsStore.getSecrets(`video:${pushId}`), {}, "push -> external must clear the secret slot");

  // external -> push: a fresh password is minted.
  await callRoute(videoRoutes, `/api/video/feeds/${pushId}`, { method: "PATCH", body: { source: { kind: "push", protocol: "whip" } } });
  const minted = (await secretsStore.getSecrets(`video:${pushId}`)).password;
  assert.ok(minted, "expected external -> push to mint a fresh password");

  // push -> pull, with no password in the body: nothing carries over.
  await callRoute(videoRoutes, `/api/video/feeds/${pushId}`, {
    method: "PATCH",
    body: { source: { kind: "pull", url: "rtsp://192.0.2.81:8554/s", username: "" } },
  });
  assert.deepEqual(
    await secretsStore.getSecrets(`video:${pushId}`),
    {},
    "push -> pull must not carry the old push password over as the pull password",
  );

  // push -> pull, WITH a password in the same body: that password (not the old one) is what lands.
  const push2 = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "PTZ 2", source: { kind: "push", protocol: "srt" } } });
  const push2Id = (push2.json as { feed: { id: string } }).feed.id;
  await callRoute(videoRoutes, `/api/video/feeds/${push2Id}`, {
    method: "PATCH",
    body: { source: { kind: "pull", url: "rtsp://192.0.2.82:8554/s", username: "" }, password: "fresh-pull-pw" },
  });
  assert.equal((await secretsStore.getSecrets(`video:${push2Id}`)).password, "fresh-pull-pw");

  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${pushId}`, { method: "DELETE" })).status, 200);
  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${push2Id}`, { method: "DELETE" })).status, 200);
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

test("a PATCH whose name is not text is refused with the name rule, and the name is kept", async () => {
  const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "Side stage", source: EMBED.source } });
  const id = (made.json as { feed: { id: string } }).feed.id;
  for (const name of [123, null, ""]) {
    const r = await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "PATCH", body: { name } });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal((r.json as { error: string }).error, "Name must be 1–60 characters.", JSON.stringify(name));
  }
  const s = (await callRoute(videoRoutes, "/api/video/state")).json as { feeds: { id: string; name: string }[] };
  assert.equal(s.feeds.find((f) => f.id === id)?.name, "Side stage");
  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" })).status, 200);
});

test("add, update and remove each push video:state, and current() carries it", async () => {
  const { addBroadcastListener } = await import("../broadcaster.js");
  const { videoService } = await import("../video/video-service.js");
  const frames: { names: string[]; rev: number }[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel !== "video:state") return;
    const s = payload as { rev: number; feeds: { name: string }[] };
    frames.push({ rev: s.rev, names: s.feeds.map((f) => f.name) });
  });
  const current = () => videoService.current().feeds.map((f) => f.name);

  const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "Choir loft", source: EMBED.source } });
  const id = (made.json as { feed: { id: string } }).feed.id;
  assert.equal(frames.length, 1, "expected a push after the add");
  assert.ok(frames[0]!.names.includes("Choir loft"));
  assert.ok(current().includes("Choir loft"), "current() must carry the added feed for the hello burst");

  await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "PATCH", body: { name: "Choir" } });
  assert.equal(frames.length, 2, "expected a push after the update");
  assert.ok(frames[1]!.names.includes("Choir") && !frames[1]!.names.includes("Choir loft"));
  assert.ok(current().includes("Choir"));

  await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" });
  assert.equal(frames.length, 3, "expected a push after the remove");
  assert.equal(frames[2]!.names.includes("Choir"), false);
  assert.equal(current().includes("Choir"), false);
  assert.ok(frames[0]!.rev < frames[1]!.rev && frames[1]!.rev < frames[2]!.rev, "each push advances rev");
});

test("the source line names the kind, then the address, protocol or ref", async () => {
  const cases: [unknown, string][] = [
    [{ kind: "embed", player: "youtube-video", ref: "dQw4w9WgXcQ" }, "YouTube or Resi · dQw4w9WgXcQ"],
    [{ kind: "external", url: "http://192.0.2.70/cam/whep" }, "Other address · http://192.0.2.70/cam/whep"],
    [{ kind: "pull", url: "rtsp://192.0.2.71:8554/s", username: "" }, "Pulled from a device · rtsp://192.0.2.71:8554/s"],
    [{ kind: "push", protocol: "whip" }, "The device pushes · WHIP (OBS)"],
  ];
  for (const [source, line] of cases) {
    const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "Line check", source } });
    assert.equal(made.status, 201, JSON.stringify(source));
    const feed = (made.json as { feed: { id: string; sourceLine: string } }).feed;
    assert.equal(feed.sourceLine, line);
    await callRoute(videoRoutes, `/api/video/feeds/${feed.id}`, { method: "DELETE" });
  }
});
