// POST /api/events/subscribe and the event routes' cid, through RemoteServer's
// real request handler on a real socket.
//
// channel-reports.test.ts holds the registry to its bounds with a clock. This
// holds the ROUTES to the registry: a report lands in the bounded store, a body
// past the cap is refused before it is read whole, a stream claims a report that
// arrived first (the order the shared worker sends them in), and a reconnect
// whose new stream opens before the old one closes keeps its report.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, mock, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-subscribe-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer, channelReports } = await import("./remote-server.js");
const { channelNamedByClient } = await import("./broadcaster.js");
const { MAX_CHANNELS, MAX_CID_LENGTH, MAX_SUBSCRIBE_BODY_BYTES, MAX_UNCLAIMED, UNCLAIMED_TTL_MS } = await import("./channel-reports.js");

let server: SocketServer;

const post = (pathname: string, body: string) => server.send("POST", pathname, { headers: { "Content-Type": "application/json" }, body });
const subscribe = (cid: unknown, channels: unknown) => post("/api/events/subscribe", JSON.stringify({ cid, channels }));

/** Resolves once `done()` holds, checking every few milliseconds; fails after `ms`.
 *  A closed socket reaches the server's close handler a moment after the client
 *  sees it go, and nothing the client can observe marks that moment. */
async function waitFor(done: () => boolean, what: string, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) assert.fail(what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An event stream held open until `close`, resolved once the server has it. */
function openStream(query: string): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: `/api/events${query}` }, (res) => {
      res.once("data", () =>
        resolve({
          close: () =>
            new Promise<void>((done) => {
              res.once("close", () => setImmediate(done));
              req.destroy();
            }),
        }),
      );
    });
    req.on("error", (err) => (err as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(err));
  });
}

before(async () => {
  server = await serveOnSocket(new RemoteServer().handle);
});

after(async () => {
  await server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("reports with made-up cids land in the bounded store, so they cannot pile up", async () => {
  for (let i = 0; i < MAX_UNCLAIMED + 50; i++) {
    const r = await subscribe(`made-up-${i}`, ["pco:live"]);
    assert.equal(r.status, 200);
  }
  assert.equal(channelReports.unclaimedCount, MAX_UNCLAIMED, "the route stored reports somewhere other than the bounded registry");
  assert.equal(channelReports.get("made-up-0"), undefined);
  assert.ok(channelReports.get(`made-up-${MAX_UNCLAIMED + 49}`));
});

test("a body past the cap is refused 413, before it is read whole", async () => {
  const r = await post("/api/events/subscribe", JSON.stringify({ cid: "big", channels: ["x".repeat(MAX_SUBSCRIBE_BODY_BYTES)] }));
  assert.equal(r.status, 413);
  assert.equal(channelReports.get("big"), undefined);
});

test("a report past the channel or cid bounds is refused 400 and stores nothing", async () => {
  const many = Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => `c${i}`);
  assert.equal((await subscribe("many", many)).status, 400);
  assert.equal(channelReports.get("many"), undefined);
  assert.equal((await subscribe("x".repeat(MAX_CID_LENGTH + 1), ["pco:live"])).status, 400);
  assert.equal((await server.send("GET", `/api/events/poll?cid=${"x".repeat(MAX_CID_LENGTH + 1)}`)).status, 400);
});

test("a missing cid is answered as it always was", async () => {
  const r = await subscribe(undefined, ["pco:live"]);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: false });
});

test("a stream claims a report that arrived before it, and takes it away when it closes", async () => {
  await subscribe("worker-1", ["video:probe"]);
  assert.equal(channelNamedByClient("video:probe"), false, "precondition: a report with no stream names nothing");
  const stream = await openStream("?cid=worker-1");
  try {
    assert.equal(channelNamedByClient("video:probe"), true, "the stream did not pick up the report that came first");
    // Claimed: a flood of new reports cannot push it out.
    for (let i = 0; i < MAX_UNCLAIMED + 1; i++) await subscribe(`flood-${i}`, []);
    assert.ok(channelReports.get("worker-1"), "a claimed report was evicted as if it were waiting");
  } finally {
    await stream.close();
  }
  await waitFor(() => channelReports.get("worker-1") === undefined, "the report outlived its stream");
  assert.equal(channelNamedByClient("video:probe"), false);
});

test("a reconnect whose new stream opens before the old one's close keeps its report", async () => {
  // An EventSource reconnect can reach the server before the close of the
  // stream it replaces. That close used to take the report the new stream was
  // relying on, and the next re-report then waited as if nothing held it.
  await subscribe("reconnecting", ["video:probe"]);
  const first = await openStream("?cid=reconnecting");
  const second = await openStream("?cid=reconnecting");
  // The server's own word that it has handled the first stream's close: the
  // assertions below mean nothing until it has.
  const realLog = console.log;
  let closed = 0;
  console.log = (...args: unknown[]) => {
    if (String(args[0]).startsWith("[events] stream client closed")) closed++;
    realLog(...args);
  };
  try {
    await first.close();
    await waitFor(() => closed === 1, "the server never saw the first stream close");
  } finally {
    console.log = realLog;
  }
  try {
    assert.ok(channelReports.get("reconnecting"), "the old stream's close took the new stream's report");
    assert.equal(channelNamedByClient("video:probe"), true);
    await subscribe("reconnecting", ["video:probe", "pco:live"]);
    for (let i = 0; i < MAX_UNCLAIMED + 1; i++) await subscribe(`after-${i}`, []);
    assert.ok(channelReports.get("reconnecting"), "the still-open stream's re-report was evicted as unclaimed");
  } finally {
    await second.close();
  }
  await waitFor(() => channelReports.get("reconnecting") === undefined, "the report outlived its last stream");
});

test("a poll client holds its report past the wait an unclaimed one gets", async () => {
  // The report reached the server before the first poll, as the shared worker
  // sends them. Polling is what claims it: without that, the next report from
  // anyone ages it out after UNCLAIMED_TTL_MS and the client is sent everything.
  await subscribe("poller", ["pco:live"]);
  assert.equal((await server.send("GET", "/api/events/poll?cid=poller")).status, 200);
  channelReports.expire(Date.now() + UNCLAIMED_TTL_MS + 1);
  assert.ok(channelReports.get("poller"), "a polling client's report aged out as if no connection held it");

  // Control: the same report with no poll behind it does age out, so the
  // assertion above is about the claim and not about expire() doing nothing.
  await subscribe("never-polled", ["pco:live"]);
  channelReports.expire(Date.now() + UNCLAIMED_TTL_MS + 1);
  assert.equal(channelReports.get("never-polled"), undefined);
});

test("a stream claims its cid only when it is one a client could have minted", async () => {
  const claim = mock.method(channelReports, "claim");
  try {
    const oversized = await openStream(`?cid=${"x".repeat(MAX_CID_LENGTH + 1)}`);
    await oversized.close();
    assert.equal(claim.mock.callCount(), 0, "a stream claimed an oversized cid");

    const ok = await openStream("?cid=sane-cid");
    await ok.close();
    assert.equal(claim.mock.callCount(), 1, "a stream with a usable cid did not claim it");
    assert.equal(claim.mock.calls[0].arguments[0], "sane-cid");
  } finally {
    claim.mock.restore();
  }
});
