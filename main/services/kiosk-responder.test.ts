// The responder over a real UDP socket. The same-machine rule is decided by a
// pure function (isFromThisMachine, tested with the discovery file), but what an
// operator needs is that the datagram handler actually applies it, so this sends
// real probes to a real listener and reads what comes back.

import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-responder-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { startKioskResponder, stopKioskResponder } = await import("./kiosk-responder.js");
const { encodeProbe, decodeReply } = await import("./kiosk-discovery.js");
const { startScan, seenDevices, resetKioskPresence } = await import("./kiosk-presence.js");

const THIS_MAC = "02:00:00:00:00:aa";
const OTHER_MAC = "02:00:00:00:00:bb";

async function freePort(): Promise<number> {
  const s = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => s.bind(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

let port = 0;
let client: dgram.Socket;
let replies: string[] = [];

before(async () => {
  port = await freePort();
  startKioskResponder({
    serverId: "srv-test",
    serverName: "Test server",
    url: () => "http://192.0.2.10:8788",
    port,
    ownMacs: () => new Set([THIS_MAC]),
  });
  // bind() is asynchronous and the responder does not say when it is ready.
  await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  stopKioskResponder();
  await fs.rm(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  resetKioskPresence();
  startScan("test");
  replies = [];
  client = dgram.createSocket("udp4");
  client.on("message", (buf) => replies.push(buf.toString()));
  await new Promise<void>((resolve) => client.bind(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => client.close(() => resolve()));
});

const send = (probe: Parameters<typeof encodeProbe>[0]) =>
  new Promise<void>((resolve, reject) =>
    client.send(encodeProbe(probe), port, "127.0.0.1", (err) => (err ? reject(err) : resolve())),
  );

/** Wait until something has been answered, or give up after `ms`. */
async function answered(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (replies.length > 0) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("a probe carrying this machine's own MAC", () => {
  test("a plain device is ignored: not answered, not listed", async () => {
    await send({ id: "self-kiosk", macs: [THIS_MAC], hostname: "server-box" });
    assert.equal(await answered(400), false, "the server answered an agent running on itself");
    assert.deepEqual(seenDevices().map((d) => d.id), []);
  });

  test("a helper output is answered and listed with its output", async () => {
    const output = { kind: "decklink" as const, name: "SDI 1 · Card A", port: "SDI 1", modes: ["1080p59.94"] };
    await send({ id: "self-mac.sdi-1", macs: [THIS_MAC], hostname: "server-box", output });
    assert.equal(await answered(2000), true, "a helper output on the server's own Mac was dropped as its own echo");
    assert.equal(decodeReply(replies[0])?.serverId, "srv-test");
    const seen = seenDevices();
    assert.deepEqual(seen.map((d) => d.id), ["self-mac.sdi-1"]);
    assert.deepEqual(seen[0].output, output);
  });

  test("a device on another machine is answered as ever", async () => {
    await send({ id: "wall-pi", macs: [OTHER_MAC], hostname: "pi" });
    assert.equal(await answered(2000), true);
    assert.deepEqual(seenDevices().map((d) => d.id), ["wall-pi"]);
    assert.equal(seenDevices()[0].output, undefined);
  });
});
