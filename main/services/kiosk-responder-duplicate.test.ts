// Another server answering discovery with this server's id, over real UDP.
//
// The decisions are pure and tested in kiosk-discovery-check.test.ts. What an
// operator needs is that the socket really sends the check, reads the answer,
// flags the address, clears it, and keeps quiet when there is nothing to clear,
// so this runs the real responder against a peer socket standing in for the
// other server.
//
// The peer is on loopback with its own port, and the responder's check is
// pointed at it (`probeTo`). In production the check is broadcast on each
// interface (broadcastAddresses). Two real servers on one Mac, sharing the
// discovery port, were driven by hand: both found the other (the second to start
// at once, the first at the other's next check, because a unicast answer to the
// shared port reaches only one socket), and the one left with the old id cleared
// about two minutes after the other took a new one.

import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-responder-dup-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { startKioskResponder, stopKioskResponder, changeServerId } = await import("./kiosk-responder.js");
const { encodeProbe, encodeReply, decodeProbe, decodeReply } = await import("./kiosk-discovery.js");
const { seenDevices, resetKioskPresence } = await import("./kiosk-presence.js");
const { updateDevices } = await import("./kiosk-devices-store.js");
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
    // Flagged as the answer arrives, while the round is still being counted.
    assert.ok(["checking", "ok"].includes(latest().check.state), latest().check.state);
    await until("the round to be counted", () => latest().check.state === "ok");
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

describe("an answer carrying this server's own address", () => {
  test("is this server's own answer handed back, not another server", async () => {
    // Two servers on one machine share the discovery port, and a unicast to it
    // can land on either socket: the answer this server sent the other one came
    // back to it, and read as a twin at its own address.
    answering = false;
    await until("the flag to clear", () => latest().duplicates.length === 0, 3000);
    peer.send(encodeReply({ serverId: OWN, name: "This box", url: "http://192.0.2.50:8788", claimed: false }), responderPort, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(latest().duplicates.length, 0, "this server took its own answer for a twin");
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

describe("a new server id", () => {
  const NEXT = "b84d17f0-3c2e-4a91-8d5b-e6097f2a1c34";

  test("drops what was heard about the old id, and checks again at once under the new one", async () => {
    answering = true;
    // The peer checks for this server's id, which flags it.
    peer.send(encodeProbe({ id: "server-check-peer", macs: [OTHER_MAC], boundTo: OWN, check: true }), responderPort, "127.0.0.1");
    await until("a duplicate", () => (latest()?.duplicates.length ?? 0) > 0);
    // The peer keeps the OLD id: it answers only checks for OWN from here on.
    const before = checks.length;
    changeServerId(NEXT);
    assert.equal(latest().id, NEXT);
    assert.deepEqual(latest().duplicates, [], "the old id's duplicate outlived the change");
    await until("a check under the new id", () => checks.slice(before).some((c) => c.boundTo === NEXT));
  });

  test("and it answers devices as the new id", async () => {
    peerReplies.length = 0;
    peer.send(encodeProbe({ id: "server-check-peer", macs: [OTHER_MAC], boundTo: NEXT, check: true }), responderPort, "127.0.0.1");
    await until("an answer", () => peerReplies.length > 0);
    assert.equal(decodeReply(peerReplies[0])?.serverId, NEXT);
    // It also flagged the peer, now as checking for the new id; drop that for what follows.
    answering = false;
    await until("the flag to clear", () => latest().duplicates.length === 0, 3000);
  });

  test("A SCREEN SET UP ONLY HERE follows the new id, as the confirm promises", async () => {
    // What New server id tells the operator: screens set up only on this server
    // follow the new id on their own. The other server (old id) tells such a
    // screen it is not set up there, so it forgets the old id; its next probe
    // names no server, and this one answers it as set up here, under the new id.
    await updateDevices(() => [{ id: "pi-here", token: "", outputId: "1", macs: [] }]);
    peerReplies.length = 0;
    const probe = (boundTo?: string) =>
      peer.send(encodeProbe({ id: "pi-here", macs: [OTHER_MAC], hostname: "pi", ...(boundTo && { boundTo }) }), responderPort, "127.0.0.1");

    probe(OWN);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(peerReplies.length, 0, "answered a screen still naming the old id: the other server has that id now");

    probe();
    await until("an answer", () => peerReplies.length > 0);
    const reply = decodeReply(peerReplies[0]);
    assert.equal(reply?.serverId, NEXT);
    assert.equal(reply?.claimed, true);
    await updateDevices(() => []);
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

describe("a check that cannot be sent while something is flagged", () => {
  test("keeps trying on the re-check schedule, so the flag can still clear", async () => {
    stopKioskResponder();
    identities.length = 0;
    startKioskResponder({
      serverId: OWN,
      serverName: "This box",
      url: () => "http://192.0.2.50:8788",
      port: responderPort,
      ownMacs: () => new Set([THIS_MAC]),
      // A name that never resolves: every send fails.
      probeTo: { address: "no-such-host.invalid", port: peerPort },
      recheckMs: RECHECK_MS,
      replyWindowMs: WINDOW_MS,
      onIdentity: (i) => identities.push(i),
    });
    await until("the check to fail", () => latest()?.check.state === "failed");
    peer.send(encodeProbe({ id: "server-check-peer", macs: [OTHER_MAC], boundTo: OWN, check: true }), responderPort, "127.0.0.1");
    await until("a duplicate", () => (latest()?.duplicates.length ?? 0) > 0);
    const failedAt = () => new Set(identities.filter((i) => i.check.state === "failed").map((i) => i.check.at)).size;
    const before = failedAt();
    await until("further attempts", () => failedAt() >= before + 2, RECHECK_MS * 20);
    assert.ok(logged.filter((l) => l.includes("could not send the duplicate-id check")).length === 1, "a run of failed sends was not one line");
  });
});
