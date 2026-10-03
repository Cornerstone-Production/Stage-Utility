// remote-server-probe-demand.test.ts — camera checks run only for a client that
// NAMES `video:probe`. A client with no filter yet counts as wanting every
// channel (broadcaster.ts's channelHasSubscribers, unchanged), so a display
// connecting, or curl, or a Home Assistant client with no cid at all, would
// otherwise have the server probing cameras with no Video feeds page open.
//
// Driven through RemoteServer's real request handler with fake request and
// response objects, not a socket: the wiring under test is the handler's
// own filter bookkeeping reaching the broadcaster.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-probe-demand-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");
const { channelHasSubscribers, channelNamedByClient, addSubscriptionListener } = await import("./broadcaster.js");
const { callRoute } = await import("./routes/route-harness.js");

type RouteCtx = import("./routes/context.js").RouteCtx;
type Handler = { handleRequest(req: RouteCtx["req"], res: RouteCtx["res"], pathname: string, url: URL, method: string): Promise<void> };
const server = new RemoteServer() as unknown as Handler;
const handle = (c: RouteCtx) => server.handleRequest(c.req, c.res, c.pathname, c.url, c.method);

let changes = 0;
addSubscriptionListener(() => changes++);

/** An open event stream: a request that can close, and a response that takes writes. */
async function openStream(query: string): Promise<{ close(): void }> {
  const req = Object.assign(new EventEmitter(), { headers: {}, socket: { remoteAddress: "127.0.0.1" } });
  // sseWrite() tells a real response from a poll sink by instanceof.
  const res = new http.ServerResponse(new http.IncomingMessage(new net.Socket()));
  const url = new URL(`http://localhost/api/events${query}`);
  await server.handleRequest(req as never, res as never, "/api/events", url, "GET");
  return { close: () => req.emit("close") };
}

const subscribe = (cid: string, channels: string[]) => callRoute(handle, "/api/events/subscribe", { method: "POST", body: { cid, channels } });

test("a stream with no filter wants every channel, and still does not count as naming video:probe", async () => {
  const s = await openStream("");
  try {
    assert.equal(channelHasSubscribers("video:probe"), true, "precondition: the general check is unchanged and fails open");
    assert.equal(channelNamedByClient("video:probe"), false, "an unfiltered client must not start camera checks");
  } finally {
    s.close();
  }
});

test("a stream with a cid but no report yet does not count either", async () => {
  const s = await openStream("?cid=fresh");
  try {
    assert.equal(channelNamedByClient("video:probe"), false);
  } finally {
    s.close();
  }
});

test("a client that reports a filter without video:probe does not count; one that names it does, and leaving ends it", async () => {
  const s = await openStream("?cid=page1");
  try {
    await subscribe("page1", ["video:state", "integrations:state-changed"]);
    assert.equal(channelNamedByClient("video:probe"), false, "another page of the app");
    const before = changes;
    await subscribe("page1", ["video:state", "video:probe"]);
    assert.equal(channelNamedByClient("video:probe"), true, "the Video feeds page");
    assert.ok(changes > before, "the broadcaster was told, so a producer can start at once");
  } finally {
    s.close();
  }
  assert.equal(channelNamedByClient("video:probe"), false, "the page closing ends it");
});

test("a polling client counts the same way", async () => {
  await callRoute(handle, "/api/events/poll?cid=panel1");
  await subscribe("panel1", ["video:state"]);
  assert.equal(channelNamedByClient("video:probe"), false);
  await subscribe("panel1", ["video:probe"]);
  assert.equal(channelNamedByClient("video:probe"), true);
  await subscribe("panel1", []);
  assert.equal(channelNamedByClient("video:probe"), false);
});

test("the video service's own demand check for camera checks is the named one", async () => {
  const { videoProbeDeps } = await import("./video/video-service.js");
  const s = await openStream("?cid=page2");
  try {
    assert.equal(videoProbeDeps.inDemand(), false, "a connected, unfiltered stream is not a Video feeds page");
    await subscribe("page2", ["video:probe"]);
    assert.equal(videoProbeDeps.inDemand(), true);
  } finally {
    s.close();
  }
});
