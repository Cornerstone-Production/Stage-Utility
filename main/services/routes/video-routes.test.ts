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

/** Adds a push feed and returns its id and secretsStore password — shared
 *  setup for the leak-proving tests below, each of which then checks
 *  exactly ONE surface so a failure there is the only failing assertion in
 *  its test. */
async function addPushFeedWithSecret(name: string): Promise<{ id: string; secret: string }> {
  const { secretsStore } = await import("../secrets.js");
  const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name, source: { kind: "push", protocol: "srt" } } });
  assert.equal(made.status, 201);
  const id = (made.json as { feed: { id: string } }).feed.id;
  const secret = (await secretsStore.getSecrets(`video:${id}`)).password;
  assert.equal(typeof secret, "string", "expected addFeed to mint a push password");
  assert.equal(secret!.length, 16, "expected a 16-character password");
  return { id, secret: secret! };
}

test("a push feed's password never lands in the feed file on disk", async () => {
  const { id, secret } = await addPushFeedWithSecret("Disk box");
  try {
    // Read raw, not through the store's own API, so a password folded into
    // `source` or a sibling field would still be caught.
    const raw = await fs.readFile(path.join(TMP, "video-feeds.json"), "utf-8");
    assert.equal(raw.includes(secret), false, "the feed file must never carry the password");
  } finally {
    await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" });
  }
});

test("a push feed's password never reaches GET /api/video/state", async () => {
  const { id, secret } = await addPushFeedWithSecret("State box");
  try {
    const state = await callRoute(videoRoutes, "/api/video/state");
    assert.equal(JSON.stringify(state.json).includes(secret), false, "GET /api/video/state must never carry the password");
  } finally {
    await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" });
  }
});

test("a push feed's password never reaches the video:state broadcast — neither the original password nor a rotated one", async () => {
  const { addBroadcastListener } = await import("../broadcaster.js");
  const frames: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "video:state") frames.push(payload);
  });

  const { id, secret } = await addPushFeedWithSecret("Broadcast box");
  try {
    const rotated = await callRoute(videoRoutes, `/api/video/feeds/${id}/push/new-password`, { method: "POST" });
    assert.equal(rotated.status, 200);
    const rotatedPassword = (rotated.json as { password: string }).password;
    assert.notEqual(rotatedPassword, secret, "expected new-password to mint a different password — or this proves nothing about the ROTATED one");

    const serialized = frames.map((f) => JSON.stringify(f));
    assert.equal(serialized.some((s) => s.includes(secret)), false, "the video:state broadcast must never carry the original password");
    assert.equal(serialized.some((s) => s.includes(rotatedPassword)), false, "the video:state broadcast must never carry a rotated password either");
  } finally {
    await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" });
  }
});

test("the push address and new-password routes carry the password, and delete clears the secret slot", async () => {
  const { secretsStore } = await import("../secrets.js");
  const { id, secret } = await addPushFeedWithSecret("Stage box");

  const address = await callRoute(videoRoutes, `/api/video/feeds/${id}/push`);
  assert.equal(address.status, 200);
  const addrBody = address.json as { protocol: string; address: string; password: string };
  assert.equal(addrBody.protocol, "srt");
  assert.equal(addrBody.password, secret);
  assert.ok(addrBody.address.includes(secret), "expected the SRT address to carry the password in its streamid");

  const rotated = await callRoute(videoRoutes, `/api/video/feeds/${id}/push/new-password`, { method: "POST" });
  assert.equal(rotated.status, 200);
  const rotatedBody = rotated.json as { password: string; applied: boolean; kicked: "dropped" | "none" | "failed" };
  assert.notEqual(rotatedBody.password, secret, "expected new-password to mint a different password");
  assert.equal((await secretsStore.getSecrets(`video:${id}`)).password, rotatedBody.password);
  assert.equal(rotatedBody.applied, true, "no relay is attached in this route test — vacuously applied");
  assert.equal(rotatedBody.kicked, "none", "no relay is attached — nobody to kick");

  assert.equal((await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(await secretsStore.getSecrets(`video:${id}`), {}, "delete must clear the push feed's secret slot");
});

test("GET /push?protocol=whip previews another protocol's address with the SAME password, without saving anything", async () => {
  const { id, secret } = await addPushFeedWithSecret("Preview box");
  try {
    const preview = await callRoute(videoRoutes, `/api/video/feeds/${id}/push?protocol=whip`);
    assert.equal(preview.status, 200);
    const body = preview.json as { protocol: string; address: string; password: string };
    assert.equal(body.protocol, "whip");
    assert.equal(body.password, `video:${secret}`);
    assert.ok(body.address.includes("/whip"));

    // An invalid protocol value just falls back to the feed's own saved one.
    const bogus = await callRoute(videoRoutes, `/api/video/feeds/${id}/push?protocol=nonsense`);
    assert.equal((bogus.json as { protocol: string }).protocol, "srt");
  } finally {
    await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" });
  }
});

test("GET /push refuses a cross-origin browser request with 403; same-origin and no Origin header both answer 200", async () => {
  const { id } = await addPushFeedWithSecret("Origin box");
  try {
    const crossOrigin = await callRoute(videoRoutes, `/api/video/feeds/${id}/push`, {
      headers: { origin: "http://evil.example", host: "localhost:8788" },
    });
    assert.equal(crossOrigin.status, 403);

    const sameOrigin = await callRoute(videoRoutes, `/api/video/feeds/${id}/push`, {
      headers: { origin: "http://localhost:8788", host: "localhost:8788" },
    });
    assert.equal(sameOrigin.status, 200);

    const noOrigin = await callRoute(videoRoutes, `/api/video/feeds/${id}/push`, { headers: {} });
    assert.equal(noOrigin.status, 200);
  } finally {
    await callRoute(videoRoutes, `/api/video/feeds/${id}`, { method: "DELETE" });
  }
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

const GOOD_PORTS = { rtmp: 41935, srt: 48890, webrtcUdp: 48189, webrtcHttp: 48889, hls: 48888, api: 49997 };

test("PATCH /api/video/ports saves six distinct in-range ports, and GET /api/video/state reflects them", async () => {
  const saved = await callRoute(videoRoutes, "/api/video/ports", { method: "PATCH", body: GOOD_PORTS });
  assert.equal(saved.status, 200);
  assert.deepEqual((saved.json as { ports: unknown }).ports, GOOD_PORTS);

  const state = (await callRoute(videoRoutes, "/api/video/state")).json as { ports: unknown };
  assert.deepEqual(state.ports, GOOD_PORTS);
});

test("PATCH /api/video/ports refuses a port outside 1024-65535, and a non-integer", async () => {
  for (const bad of [
    { ...GOOD_PORTS, rtmp: 80 },
    { ...GOOD_PORTS, api: 70000 },
    { ...GOOD_PORTS, hls: 8888.5 },
    { ...GOOD_PORTS, srt: "8890" },
  ]) {
    const r = await callRoute(videoRoutes, "/api/video/ports", { method: "PATCH", body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match((r.json as { error: string }).error, /1024 to 65535/);
  }
});

test("PATCH /api/video/ports refuses two ports set to the same value", async () => {
  const r = await callRoute(videoRoutes, "/api/video/ports", {
    method: "PATCH",
    body: { ...GOOD_PORTS, srt: GOOD_PORTS.rtmp },
  });
  assert.equal(r.status, 400);
  assert.match((r.json as { error: string }).error, /must be different/);
});

// The read behind the Video feeds page's own hydrate: useStatusChannel()
// reads GET /api/video/probe once beside subscribing, so a stale replayed
// frame from an earlier page is corrected by the server's present snapshot.
test("GET /api/video/probe answers the same snapshot video:probe pushes; empty while nobody watches", async () => {
  const r = await callRoute(videoRoutes, "/api/video/probe");
  assert.equal(r.status, 200);
  assert.deepEqual((r.json as { feeds: unknown }).feeds, {});
  assert.equal(typeof (r.json as { at: unknown }).at, "number", "stamped with the server's clock, for the page's ages");
});
