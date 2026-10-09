// The responder over a real UDP socket. The same-machine rule is decided by a
// pure function (isFromThisMachine, tested with the discovery file), but what an
// operator needs is that the datagram handler actually applies it, so this sends
// real probes to a real listener and reads what comes back.

import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-responder-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { startKioskResponder, stopKioskResponder } = await import("./kiosk-responder.js");
const { encodeProbe, decodeReply } = await import("./kiosk-discovery.js");
const { startScan, seenDevices, resetKioskPresence } = await import("./kiosk-presence.js");
const { kioskDevicesStore, updateDevices, release } = await import("./kiosk-devices-store.js");

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
  await updateDevices(() => []);
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

describe("a helper output bound to this server", () => {
  const output = { kind: "decklink" as const, name: "SDI 1 · Card A", port: "SDI 1" };
  const ID = "other-mac.sdi-1";
  const bound = { id: ID, macs: [OTHER_MAC], hostname: "booth-mini", boundTo: "srv-test", output };
  const bind = () => updateDevices(() => [{ id: ID, token: "t", outputId: "display-1", macs: [OTHER_MAC], output }]);

  /** Send, then wait for the answer: every probe here is answered, and the answer
   *  goes out after the handler has done what it does with the probe. */
  async function probe(p: Parameters<typeof encodeProbe>[0]): Promise<void> {
    const before = replies.length;
    await send(p);
    const until = Date.now() + 2000;
    while (replies.length === before && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.ok(replies.length > before, "the probe was never answered");
  }

  const lines: string[] = [];
  const realLog = console.log;
  beforeEach(() => {
    lines.length = 0;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.log = realLog;
    mock.timers.reset();
  });
  const seenLines = () => lines.filter((l) => l.includes("[output-helper] output seen"));

  test("is not logged as 'output seen' however long it keeps probing", async () => {
    // The line is once per output HEARD, so a bound one - which is not a candidate
    // to claim - is never one. Probes a minute apart, by the clock the presence
    // module reads, over a real socket.
    await bind();
    const t0 = Date.now();
    mock.timers.enable({ apis: ["Date"], now: t0 });
    for (let i = 0; i < 5; i++) {
      await probe(bound);
      mock.timers.setTime(t0 + (i + 1) * 61_000);
    }
    assert.deepEqual(seenLines(), [], `a bound output was logged as newly seen:\n${seenLines().join("\n")}`);
    assert.deepEqual(seenDevices().map((d) => d.id), [], "a bound output was listed as a candidate to claim");
  });

  test("an unbound output is logged once when first heard, and not again", async () => {
    // The other half, so the test above cannot pass by the line having been
    // removed: an output nobody has claimed is heard once however long it probes.
    const t0 = Date.now();
    mock.timers.enable({ apis: ["Date"], now: t0 });
    startScan("long", 30 * 60_000);
    for (let i = 0; i < 5; i++) {
      await probe({ ...bound, boundTo: undefined });
      mock.timers.setTime(t0 + (i + 1) * 61_000);
    }
    assert.equal(seenLines().length, 1, `expected one line:\n${seenLines().join("\n")}`);
    assert.match(seenLines()[0], /^\[output-helper\] output seen: other-mac\.sdi-1 \(decklink "SDI 1 · Card A"\) on booth-mini$/);
  });

  test("is answered but not listed or logged by a probe that does not carry its binding yet", async () => {
    // The probe already on the wire when it was claimed, or one from a helper that
    // has not heard the answer: no boundTo, while a scan is open. It is ours, so it
    // is answered (that is how it learns the binding) and it is not a candidate.
    await bind();
    startScan("long", 30 * 60_000);
    await probe({ ...bound, boundTo: undefined });
    assert.deepEqual(seenLines(), [], "a bound output was logged as newly seen");
    assert.deepEqual(seenDevices().map((d) => d.id), [], "a bound output was listed as a candidate to claim");
  });

  test("a probe keeps the stored output current", async () => {
    // A card reporting new modes, or an output renamed, must reach the binding the
    // Screen settings read it from: the responder hands the probe's output to
    // touch(), and a probe that did not would leave the stored one as it was
    // claimed.
    await bind();
    const renamed = { kind: "decklink" as const, name: "SDI 1 · Card B", port: "SDI 1", modes: ["1080p59.94", "720p60"] };
    await probe({ ...bound, output: renamed });
    const stored = (await kioskDevicesStore.load()).find((d) => d.id === ID);
    assert.deepEqual(stored?.output, renamed, "the stored binding kept the output it was claimed with");
  });

  test("a released output is listed at its very next probe", async () => {
    // Bound and heard, then released while the helper still says it is bound here
    // (it only learns otherwise from the server): back on the list at once.
    await bind();
    await probe(bound);
    assert.deepEqual(seenDevices().map((d) => d.id), []);
    await updateDevices((cur) => release(cur, ID));
    await probe(bound);
    assert.deepEqual(
      seenDevices().map((d) => d.id),
      [ID],
      "a released output was not listed at its next probe",
    );
    assert.equal(
      seenDevices()[0].boundTo,
      undefined,
      "a released output that names THIS server was listed as set up on another one",
    );
  });
});
