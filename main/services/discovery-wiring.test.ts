// The discovery responder wired to the stage controller, as remote-server wires it.
//
// The parts on either side are tested alone: the responder over real UDP, the
// controller's New server id through its route. What neither can see is the wire
// between them. Without the check's findings handed to the controller, there is no
// row, no alert, and New server id always answers 409. Without the responder
// reading its id from the controller, and re-checking when it changes, New server
// id saves the new id and the socket answers as the old one until a restart.
//
// So this runs the real path: remote-server's own startDiscovery (which mints the
// id and builds the options with discoveryOptions()), the real responder on loopback, the real request handler, and a peer socket standing in
// for the other server and for a screen.

import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-discovery-wiring-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");
const { stageController } = await import("./stage-controller.js");
const { settingsStore } = await import("./settings-store.js");
const { stopKioskResponder } = await import("./kiosk-responder.js");
const { encodeProbe, encodeReply, decodeProbe, decodeReply } = await import("./kiosk-discovery.js");
type DiscoveryProbe = import("../types/kiosk.js").DiscoveryProbe;

let server: SocketServer;
let peer: dgram.Socket;
let responderPort = 0;
const checks: DiscoveryProbe[] = [];
const replies: string[] = [];
const realLog = console.log;
const realWarn = console.warn;

async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function freePort(): Promise<number> {
  const s = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => s.bind(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** The id discovery minted on start, as the stage state should then hold it. */
let OWN = "";

before(async () => {
  console.log = () => {};
  console.warn = () => {};
  responderPort = await freePort();
  // A fresh install switching discovery on: no id yet, so the start mints one.
  await settingsStore.patch({ kioskDiscovery: true, kioskDiscoveryPort: responderPort, serverId: null });
  const remote = new RemoteServer();
  server = await serveOnSocket(remote.handle);

  // The other server: carries whatever id the first check names, and answers
  // every check for that id with it, from its own address.
  let peerId: string | undefined;
  peer = dgram.createSocket("udp4");
  peer.on("message", (buf, rinfo) => {
    const probe = decodeProbe(buf);
    if (probe?.check) {
      checks.push(probe);
      peerId ??= probe.boundTo;
      if (probe.boundTo === peerId) {
        peer.send(encodeReply({ serverId: peerId!, name: "Other box", url: "http://192.0.2.60:8788", claimed: false }), rinfo.port, rinfo.address);
      }
      return;
    }
    if (decodeReply(buf)) replies.push(buf.toString());
  });
  await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));

  // startDiscovery itself, as the server's start runs it: only where the check
  // goes and how fast are the test's.
  await (remote as unknown as { startDiscovery(o: object): Promise<void> }).startDiscovery({
    ownMacs: () => new Set(["02:00:00:00:00:aa"]),
    probeTo: { address: "127.0.0.1", port: peer.address().port },
    // Long: the only check after New server id may be the one it sends at once.
    recheckMs: 60_000,
    replyWindowMs: 50,
  });
  OWN = (await settingsStore.load()).serverId ?? "";
});

after(async () => {
  stopKioskResponder();
  await new Promise<void>((resolve) => peer.close(() => resolve()));
  await server.close();
  console.log = realLog;
  console.warn = realWarn;
  await fs.rm(TMP, { recursive: true, force: true });
});

test("STARTING DISCOVERY MINTS THE ID AND PUTS IT IN THE STAGE STATE", async () => {
  assert.match(OWN, /^[0-9a-f-]{36}$/, "no id was minted");
  assert.equal(stageController.getState().serverIdentity.id, OWN, "the Server id row would say None yet");
});

test("WHAT THE CHECK FINDS REACHES THE STAGE STATE", async () => {
  await until("the duplicate in the state", () => stageController.getState().serverIdentity.duplicates.length > 0);
  assert.equal(stageController.getState().serverIdentity.duplicates[0].url, "http://192.0.2.60:8788");
});

test("NEW SERVER ID IS ANSWERED WITH AT ONCE, AND CHECKED FOR AT ONCE", async () => {
  const r = await server.send("POST", "/api/server-id/new", { headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 200);
  const next = stageController.getState().serverIdentity.id;
  assert.ok(next && next !== OWN);

  // A check under the new id goes out now, not at the next minute's re-check.
  await until("a check under the new id", () => checks.some((c) => c.boundTo === next), 2000);

  // And a screen naming the new id is answered as it, by the running socket.
  replies.length = 0;
  peer.send(encodeProbe({ id: "pi-1", macs: ["02:00:00:00:00:bb"], hostname: "pi", boundTo: next! }), responderPort, "127.0.0.1");
  await until("an answer", () => replies.length > 0);
  assert.equal(decodeReply(replies[0])?.serverId, next, "the socket still answers as the old id until a restart");
});
