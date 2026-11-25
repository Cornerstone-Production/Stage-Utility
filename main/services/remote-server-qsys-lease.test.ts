// A Q-SYS momentary's lease against the event transport, through RemoteServer's
// real request handler on a real socket, the real writer and the fake Core.
//
// qsys-write.test.ts holds the leases to the connection they are handed. This
// holds the SERVER to handing over the right one: the press is a POST on its own
// socket, so which connection it belongs to is the newest stream (or poll
// client) carrying its cid when it arrives, and only that connection ending
// releases it. A page's cid outlives its connections, and the server can hear of
// an old socket's death late: that close must not release a press made since.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-lease-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer, sweepPollClients } = await import("./remote-server.js");
const { FakeQrcServer } = await import("./qsys/fake-qrc-server.js");
const { qsysService } = await import("./qsys/qsys-service.js");
const { qsysWatch } = await import("./qsys/qsys-watch.js");
const { qsysWriter } = await import("./qsys/qsys-write.js");
const { qsysWriteLog } = await import("./qsys/qsys-write-log.js");
const { qsysAllowlist } = await import("./qsys/qsys-allowlist-store.js");
const { viewsStore } = await import("./views-store.js");
const { POLL_CLIENT_TTL_MS } = await import("./event-poll.js");

const MUTE = { component: "Lobby_Mixer", control: "output.1.mute" };
const fake = new FakeQrcServer();
fake.components.set("Lobby_Mixer", [{ Name: "output.1.mute", Type: "Boolean", Value: false, String: "false", Position: 0, Direction: "Read/Write" }]);
let server: SocketServer;

/** Every [qsys] and [events] line these tests make on purpose, kept off the test output. */
const quiet = { log: console.log, warn: console.warn };
const lines: string[] = [];

async function waitFor(done: () => boolean, what: string, ms = 3000): Promise<void> {
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
    req.on("error", (err) => ((err as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(err)));
  });
}

/** Close `stream` and wait for the server's own close handler to have run. */
async function closeAndWait(stream: { close(): Promise<void> }): Promise<void> {
  const before = lines.filter((l) => l.startsWith("[events] stream client closed")).length;
  await stream.close();
  await waitFor(() => lines.filter((l) => l.startsWith("[events] stream client closed")).length > before, "the server never saw the stream close");
}

const press = (cid: string) =>
  server.send("POST", "/api/qsys/write", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...MUTE, value: true, lease: true, cid, panelId: "panel-m" }),
  });
const muteSets = () =>
  fake.received
    .filter((r) => r.method === "Component.Set" && (r.params as { Controls: { Name: string }[] }).Controls[0].Name === "output.1.mute")
    .map((r) => (r.params as { Controls: { Value: unknown }[] }).Controls[0].Value);

before(async () => {
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  const port = await fake.start();
  await qsysAllowlist.replace([{ ...MUTE, label: "Talk", min: null, max: null, confirm: "none" }]);
  await viewsStore.save([
    {
      id: "panel-m",
      name: "M",
      kind: "custom",
      createdAt: "2026-01-01",
      layout: { version: 1, canvas: {}, objects: [{ id: "b1", x: 0, y: 0, w: 0.1, h: 0.1, z: 0, config: { type: "qsys-button", binding: MUTE, label: "Talk", hold: false, press: "momentary" } }] },
    },
  ] as never);
  server = await serveOnSocket(new RemoteServer().handle);
  qsysService.configure({ host: "127.0.0.1", port, user: "", enabled: true, volunteerMeterHz: 10, staffMeterHz: 20 }, null);
  await waitFor(() => qsysService.transport !== null, "connected");
  await qsysWatch.recompute();
  await waitFor(() => qsysWatch.ready(), "writable");
});

after(async () => {
  qsysWriter.leases.clear();
  qsysService.stop();
  await server.close();
  await fake.stop();
  await qsysWriteLog.whenIdle();
  console.log = quiet.log;
  console.warn = quiet.warn;
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("a momentary's lease and the connection it was pressed on", { timeout: 20_000 }, () => {
  test("a late close of the page's replaced stream releases nothing; closing the stream it pressed on releases at once", async () => {
    const old = await openStream("?cid=talk-page");
    // The page reconnected: its new stream is open before the server hears the old one die.
    const current = await openStream("?cid=talk-page");
    try {
      const r = await press("talk-page");
      assert.equal((JSON.parse(r.body) as { ok: boolean }).ok, true, r.body);
      assert.equal(qsysWriter.leases.has(MUTE), true);
      await closeAndWait(old);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(muteSets(), [true], "the old stream's late close turned the talkback off mid-hold");
      assert.equal(qsysWriter.leases.has(MUTE), true, "the old stream's late close ended the lease");
    } finally {
      await closeAndWait(current);
    }
    await waitFor(() => muteSets().length === 2, "closing the stream it was pressed on did not release it");
    assert.deepEqual(muteSets(), [true, false]);
    assert.ok(lines.some((l) => /momentary Lobby_Mixer\/output\.1\.mute released by the server: the pressing page's event stream closed/.test(l)), lines.join("\n"));
  });

  test("a poll client's expiry releases what was pressed on it", async () => {
    const polled = await server.send("GET", "/api/events/poll?cid=talk-poller");
    assert.equal(polled.status, 200);
    const before = muteSets().length;
    const r = await press("talk-poller");
    assert.equal((JSON.parse(r.body) as { ok: boolean }).ok, true, r.body);
    assert.equal(qsysWriter.leases.has(MUTE), true);
    const closedLines = () => lines.filter((l) => /released by the server: the pressing page's event stream closed/.test(l)).length;
    const closedBefore = closedLines();
    sweepPollClients(Date.now() + POLL_CLIENT_TTL_MS + 1);
    // Well inside the lease's own 2 s expiry, so the release is the poll client's.
    await waitFor(() => closedLines() > closedBefore, "the poll client's expiry did not release it", 1000);
    await waitFor(() => muteSets().length === before + 2, "the release was not sent");
    assert.equal(muteSets().at(-1), false);
  });
});
