// Another server answering discovery with this server's id, over real UDP.
//
// The decisions are pure and tested in kiosk-discovery-check.test.ts. What an
// operator needs is that the socket really sends the check, reads the answer,
// flags the address, clears it, and keeps quiet when there is nothing to clear,
// so this runs the real responder against a peer socket standing in for the
// other server.
//
// The peer is on loopback with its own port, and the responder's check is
// pointed at it (`probeTo`). In production the check is a broadcast to the
// discovery port, and two servers on ONE machine both bound to that port cannot
// be told apart this way: the unicast answer reaches only one of them. Two real
// servers were driven by hand for that; see the PR.

import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-responder-dup-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { startKioskResponder, stopKioskResponder } = await import("./kiosk-responder.js");
const { encodeProbe, encodeReply, decodeProbe, decodeReply } = await import("./kiosk-discovery.js");
const { seenDevices, resetKioskPresence } = await import("./kiosk-presence.js");
type ServerIdentity = import("../types/kiosk.js").ServerIdentity;
type DiscoveryProbe = import("../types/kiosk.js").DiscoveryProbe;

const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
const THIS_MAC = "02:00:00:00:00:aa";
const OTHER_MAC = "02:00:00:00:00:bb";
const RECHECK_MS = 120;
const WINDOW_MS = 60;

async function freePort(): Promise<number> {
  const s = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => s.bind(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The other server: answers this server's checks with this server's id while `answering`. */
let peer: dgram.Socket;
let peerPort = 0;
let answering = true;
/** Every check probe the peer received. */
const checks: DiscoveryProbe[] = [];
/** Every reply the peer received (to probes it sent itself). */
const peerReplies: string[] = [];

let responderPort = 0;
const identities: ServerIdentity[] = [];
const latest = () => identities[identities.length - 1];
const realLog = console.log;
const realWarn = console.warn;
const logged: string[] = [];

before(async () => {
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  console.warn = (...a: unknown[]) => logged.push(a.join(" "));
  peer = dgram.createSocket("udp4");
  peer.on("message", (buf, rinfo) => {
    const probe = decodeProbe(buf);
    if (probe?.check) {
      checks.push(probe);
      if (answering) {
        peer.send(encodeReply({ serverId: OWN, name: "Other box", url: "http://192.0.2.60:8788", claimed: false }), rinfo.port, rinfo.address);
      }
      return;
    }
    if (decodeReply(buf)) peerReplies.push(buf.toString());
  });
  await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));
  peerPort = peer.address().port;
  responderPort = await freePort();
  startKioskResponder({
    serverId: OWN,
    serverName: "This box",
    url: () => "http://192.0.2.50:8788",
    port: responderPort,
    ownMacs: () => new Set([THIS_MAC]),
    probeTo: { address: "127.0.0.1", port: peerPort },
    recheckMs: RECHECK_MS,
    replyWindowMs: WINDOW_MS,
    onIdentity: (i) => identities.push(i),
  });
});

after(async () => {
  stopKioskResponder();
  await new Promise<void>((resolve) => peer.close(() => resolve()));
  console.log = realLog;
  console.warn = realWarn;
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("the check this server sends", () => {
  test("goes out when the responder starts, naming this server's id", async () => {
    await until("a check probe", () => checks.length > 0);
    assert.equal(checks[0].boundTo, OWN);
    assert.ok(checks[0].id.startsWith("server-check-"));
  });

  test("ANOTHER SERVER ANSWERING IT WITH THIS SERVER'S ID IS FLAGGED", async () => {
    await until("a duplicate", () => (latest()?.duplicates.length ?? 0) > 0);
    const dup = latest().duplicates[0];
    assert.equal(dup.address, "127.0.0.1");
    assert.equal(dup.url, "http://192.0.2.60:8788");
    assert.equal(latest().id, OWN);
    assert.equal(latest().check.state, "ok");
    assert.ok(
      logged.some((l) => l.includes("[kiosk-responder] another server at 127.0.0.1") && l.includes("answers as this server")),
      "no [kiosk-responder] line said so",
    );
  });

  test("is sent again while something is flagged, so the flag can clear", async () => {
    const before = checks.length;
    await until("a re-check", () => checks.length >= before + 2);
  });

  test("the flag clears after two rounds with no answer, and says so once", async () => {
    answering = false;
    const atSilence = checks.length;
    await until("the flag to clear", () => latest().duplicates.length === 0);
    assert.ok(checks.length - atSilence >= 2, `cleared after ${checks.length - atSilence} silent round(s); one lost datagram must not clear it`);
    assert.equal(logged.filter((l) => l.includes("127.0.0.1 no longer answers as this server")).length, 1);
  });

  test("nothing flagged, nothing more is sent: no timer runs for a healthy server", async () => {
    const quiet = checks.length;
    await new Promise((r) => setTimeout(r, RECHECK_MS * 5));
    assert.ok(checks.length - quiet <= 1, `${checks.length - quiet} checks went out with nothing flagged`);
  });
});

describe("a check another server sends", () => {
  const send = (probe: DiscoveryProbe) =>
    new Promise<void>((resolve, reject) =>
      peer.send(encodeProbe(probe), responderPort, "127.0.0.1", (err) => (err ? reject(err) : resolve())),
    );

  test("FOR THIS SERVER'S ID is answered, flagged, and never listed as a screen", async () => {
    resetKioskPresence();
    peerReplies.length = 0;
    answering = true;
    await send({ id: "server-check-peer", macs: [OTHER_MAC], hostname: "other-box", boundTo: OWN, check: true });
    await until("an answer", () => peerReplies.length > 0);
    assert.equal(decodeReply(peerReplies[0])?.serverId, OWN);
    await until("a duplicate", () => (latest()?.duplicates.length ?? 0) > 0);
    assert.deepEqual(seenDevices().map((d) => d.id), [], "the other server was listed as a screen to set up");
  });

  test("for another id is not answered, not flagged and not listed", async () => {
    answering = false;
    await until("the flag to clear", () => latest().duplicates.length === 0, 3000);
    resetKioskPresence();
    peerReplies.length = 0;
    await send({ id: "server-check-peer", macs: [OTHER_MAC], hostname: "other-box", boundTo: "some-other-id", check: true });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(peerReplies.length, 0);
    assert.equal(latest().duplicates.length, 0);
    assert.deepEqual(seenDevices().map((d) => d.id), []);
  });
});

describe("this server's own check, heard back", () => {
  test("is not a duplicate", async () => {
    // Pointed at itself, as a broadcast loops back to its sender.
    stopKioskResponder();
    identities.length = 0;
    startKioskResponder({
      serverId: OWN,
      serverName: "This box",
      url: () => "http://192.0.2.50:8788",
      port: responderPort,
      ownMacs: () => new Set<string>(),
      probeTo: { address: "127.0.0.1", port: responderPort },
      recheckMs: RECHECK_MS,
      replyWindowMs: WINDOW_MS,
      onIdentity: (i) => identities.push(i),
    });
    await until("a finished check", () => latest()?.check.state === "ok");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(latest().duplicates.length, 0, "this server took its own check for another server's");
  });
});
