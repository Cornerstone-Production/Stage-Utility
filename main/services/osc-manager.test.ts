// The receive half of the OSC manager: which target a packet is attributed to,
// and how much of the message survives being stored.
//
// Drives the REAL receive path — the same method the UDP socket's "message"
// handler calls — with a stubbed DNS lookup. No packet is sent anywhere: the
// manager's send socket is never used here, and the only target configured
// carries no subscribe address, so nothing goes out on the wire.

import assert from "node:assert/strict";
import { describe, test, before, beforeEach, after } from "node:test";
import * as dgram from "node:dgram";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-osc-manager-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { oscManager, oscDeps } = await import("./osc-manager.js");
const { oscStore } = await import("./osc-store.js");
const { encodeMessage } = await import("./osc-codec.js");

const BY_IP = "11111111-1111-4111-8111-111111111111";
const BY_NAME = "22222222-2222-4222-8222-222222222222";
const IP_HOST = "192.0.2.10"; // TEST-NET-1, RFC 5737 — routable nowhere
const NAME_HOST = "console.invalid"; // .invalid never resolves, RFC 2606
const NAME_IP = "192.0.2.20";

/** No subscribe address on either target, so reapply() starts no keepalive and
 *  the manager sends nothing. */
const TARGETS = [
  { id: BY_IP, name: "Desk by address", enabled: true, config: { host: IP_HOST, port: 8000 } },
  { id: BY_NAME, name: "Desk by name", enabled: true, config: { host: NAME_HOST, port: 8000 } },
];

/** The resolve pass is a background refresh nothing in the server waits for, so
 *  the manager hands it out (whenResolved) rather than the test guessing how
 *  many milliseconds an async DNS chain takes — which on a loaded machine is
 *  how a guard becomes a coin toss. It flaked exactly that way before this. */
const settle = () => oscManager.whenResolved();

/** A UDP port nothing is on, found by binding 0 and reading what the OS gave. */
async function freePort(): Promise<number> {
  const probe = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => probe.bind(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise<void>((resolve) => probe.close(resolve));
  return port;
}

/** The feedback port for this run. NEVER 9000: that is the default a real
 *  instance on this machine is already listening on, and stealing it — or
 *  failing to and then testing a manager with no socket — is not this test's
 *  business. Set before anything else so the manager never reaches for 9000. */
let PORT = 0;

before(async () => {
  PORT = await freePort();
  await oscManager.setFeedbackPort(PORT);
  await fs.writeFile(path.join(TMP, "osc-targets.json"), JSON.stringify(TARGETS), "utf8");
  oscDeps.lookup = async (hostname) => {
    if (hostname === NAME_HOST) return [NAME_IP];
    throw new Error(`unexpected lookup of ${hostname}`);
  };
  await oscManager.reloadTargets();
  await settle();
});

after(() => {
  oscManager.stop();
});

/** Put the target list back and re-resolve. Through the STORE, not by writing
 *  the file: DataStore.load answers from an in-memory cache once it has read
 *  once, so a direct write after that is invisible to reloadTargets. Two tests
 *  change the list — one removes a target, one replaces it — and every test
 *  below starts from the canonical two. Each uses its own address, so stored
 *  values do not collide. */
beforeEach(async () => {
  await oscStore.save(TARGETS);
  await oscManager.reloadTargets();
  await settle();
});

const values = () => oscManager.getFeedback().values;

describe("which target a packet is attributed to", () => {
  test("an IP-configured target keeps its own key", () => {
    oscManager.receive(encodeMessage("/ch/01/mix/on", [{ type: "i", value: 1 }]), IP_HOST);
    assert.equal(values()[`${BY_IP}::/ch/01/mix/on`], 1);
    assert.equal(values()["*::/ch/01/mix/on"], 1);
  });

  test("a HOSTNAME-configured target's values land under its own key too", () => {
    // THE GUARD. The sender used to be matched on `config.host === sourceIp`
    // alone, so "console.invalid" never equalled "192.0.2.20" and everything
    // that target sent was filed under the wildcard — indistinguishable from
    // every other sender on the network, and unusable as a rule's target.
    oscManager.receive(encodeMessage("/record", [{ type: "f", value: 1 }]), NAME_IP);
    const v = values();
    assert.equal(
      v[`${BY_NAME}::/record`],
      1,
      "a target configured by hostname must resolve to its own id, not fall back to the wildcard",
    );
    assert.equal(v["*::/record"], 1, "the wildcard key stays, so an existing binding still matches");
  });

  test("an unknown sender is still filed under the wildcard alone", () => {
    oscManager.receive(encodeMessage("/foo", [{ type: "i", value: 7 }]), "192.0.2.99");
    const keys = Object.keys(values()).filter((k) => k.endsWith("::/foo"));
    assert.deepEqual(keys, ["*::/foo"]);
  });

  test("a hostname that does not resolve costs the other targets nothing", async () => {
    // One unresolvable target must not abort the pass — the IP-configured one
    // does not go through DNS at all, and a second named one would still be
    // resolved.
    oscDeps.lookup = async (hostname) => {
      if (hostname === NAME_HOST) throw new Error("EAI_AGAIN");
      return [];
    };
    await oscManager.reloadTargets();
    await settle();
    oscManager.receive(encodeMessage("/ch/01/mix/on", [{ type: "i", value: 1 }]), IP_HOST);
    assert.equal(values()[`${BY_IP}::/ch/01/mix/on`], 1);
    // Restore for the rest of the file.
    oscDeps.lookup = async (hostname) => (hostname === NAME_HOST ? [NAME_IP] : []);
  });
});

describe("two targets on one address", () => {
  test("only the first is attributed, and the operator is told", async () => {
    // A packet carries a source ADDRESS and no port, so an X32 entry for
    // sending and a second entry for its /xremote subscribe are the same sender
    // as far as this can tell. A layout button survives on the wildcard; a rule
    // scoped to the second target builds a key nothing ever writes and fires
    // never. Silently, before this.
    const SHARED = "192.0.2.50";
    const A = "aaaaaaaa-0000-4000-8000-000000000001";
    const B = "bbbbbbbb-0000-4000-8000-000000000002";
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      await oscStore.save([
        { id: A, name: "Desk send", enabled: true, config: { host: SHARED, port: 10023 } },
        { id: B, name: "Desk subscribe", enabled: true, config: { host: SHARED, port: 10024 } },
      ]);
      await oscManager.reloadTargets();
      await settle();
      oscManager.receive(encodeMessage("/shared", [{ type: "i", value: 1 }]), SHARED);
      const keys = Object.keys(values()).filter((k) => k.endsWith("::/shared")).sort();
      assert.deepEqual(keys, [`${A}::/shared`, "*::/shared"].sort(), "the FIRST target wins the key");
      assert.ok(
        warnings.some((w) => w.includes(SHARED) && w.includes("Desk send") && w.includes("Desk subscribe")),
        "nothing warned that two enabled targets share an address — a rule scoped to the second " +
          `would fire never, silently. Warnings seen: ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = realWarn;
    }
  });

  test("two NAMES resolving to one address break the tie the same way", async () => {
    // The literal lookup is a `find` (first wins) and the resolved map was a
    // `set` (last wins). Two targets on one box would be attributed to
    // DIFFERENT ones depending on whether the operator typed an address or a
    // name — same config, opposite answer, nothing saying so.
    const A = "cccccccc-0000-4000-8000-000000000003";
    const B = "dddddddd-0000-4000-8000-000000000004";
    const ONE_IP = "192.0.2.60";
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      oscDeps.lookup = async () => [ONE_IP];
      await oscStore.save([
        { id: A, name: "By name one", enabled: true, config: { host: "one.invalid", port: 10023 } },
        { id: B, name: "By name two", enabled: true, config: { host: "two.invalid", port: 10024 } },
      ]);
      await oscManager.reloadTargets();
      await settle();
      oscManager.receive(encodeMessage("/tie", [{ type: "i", value: 1 }]), ONE_IP);
      assert.equal(
        values()[`${A}::/tie`],
        1,
        "the FIRST configured target must win, exactly as the literal-address lookup does",
      );
      assert.equal(values()[`${B}::/tie`], undefined);
    } finally {
      console.warn = realWarn;
      oscDeps.lookup = async (hostname) => (hostname === NAME_HOST ? [NAME_IP] : []);
    }
  });
});

describe("how much of a message is stored", () => {
  test("a single-argument message lands exactly where it always did", () => {
    // The one thing neither fix may change: this is every osc-button binding in
    // use today. `targetId::address`, no suffix.
    oscManager.receive(encodeMessage("/ch/01/mix/fader", [{ type: "f", value: 0.75 }]), IP_HOST);
    const v = values();
    assert.equal(Math.round((v[`${BY_IP}::/ch/01/mix/fader`] as number) * 100), 75);
    assert.equal(v[`${BY_IP}::/ch/01/mix/fader#1`], undefined, "one argument must not invent a second key");
  });

  test("a zero-argument message is still a bang", () => {
    oscManager.receive(encodeMessage("/go", []), IP_HOST);
    assert.equal(values()[`${BY_IP}::/go`], true);
  });

  test("the SECOND argument survives", () => {
    // THE GUARD. A console replying with a channel number and a value used to be
    // truncated to the channel number, so the value — the only interesting half
    // — was thrown away before anything could read it.
    oscManager.receive(
      encodeMessage("/fader", [{ type: "i", value: 3 }, { type: "f", value: 0.5 }]),
      IP_HOST,
    );
    const v = values();
    assert.equal(v[`${BY_IP}::/fader`], 3, "argument 0 keeps the bare key");
    assert.equal(v[`${BY_IP}::/fader#1`], 0.5, "argument 1 was dropped — a multi-argument reply is truncated");
    assert.equal(v["*::/fader#1"], 0.5, "the wildcard carries the extra arguments too");
  });

  test("a shorter later message clears the arguments the longer one left", () => {
    oscManager.receive(
      encodeMessage("/x", [{ type: "i", value: 1 }, { type: "i", value: 2 }, { type: "i", value: 3 }]),
      IP_HOST,
    );
    assert.equal(values()[`${BY_IP}::/x#2`], 3);
    oscManager.receive(encodeMessage("/x", [{ type: "i", value: 9 }]), IP_HOST);
    const v = values();
    assert.equal(v[`${BY_IP}::/x`], 9);
    assert.equal(v[`${BY_IP}::/x#1`], undefined, "a stale argument would be read as current by a rule");
    assert.equal(v[`${BY_IP}::/x#2`], undefined);
  });

  test("no more than eight arguments are kept", () => {
    const args = Array.from({ length: 12 }, (_, i) => ({ type: "i" as const, value: i }));
    oscManager.receive(encodeMessage("/long", args), IP_HOST);
    const v = values();
    assert.equal(v[`${BY_IP}::/long#7`], 7);
    assert.equal(v[`${BY_IP}::/long#8`], undefined, "the cap is eight arguments, index 0 through 7");
  });

  test("a bundle's messages are each stored whole", () => {
    // Bundles are how an X32 answers /xremote, and each message inside one gets
    // the same treatment.
    const inner = [
      encodeMessage("/a", [{ type: "i", value: 1 }, { type: "s", value: "on" }]),
      encodeMessage("/b", [{ type: "i", value: 2 }]),
    ];
    const parts: Buffer[] = [Buffer.from("#bundle\0", "ascii"), Buffer.alloc(8)];
    for (const m of inner) {
      const size = Buffer.alloc(4);
      size.writeInt32BE(m.length, 0);
      parts.push(size, m);
    }
    oscManager.receive(Buffer.concat(parts), IP_HOST);
    const v = values();
    assert.equal(v[`${BY_IP}::/a`], 1);
    assert.equal(v[`${BY_IP}::/a#1`], "on");
    assert.equal(v[`${BY_IP}::/b`], 2);
  });

  test("a removed target takes its extra-argument keys with it", async () => {
    oscManager.receive(
      encodeMessage("/gone", [{ type: "i", value: 1 }, { type: "i", value: 2 }]),
      IP_HOST,
    );
    assert.equal(values()[`${BY_IP}::/gone#1`], 2);
    await oscManager.removeTarget({ id: BY_IP });
    await settle();
    assert.deepEqual(
      Object.keys(values()).filter((k) => k.startsWith(`${BY_IP}::`)),
      [],
      "removing a target must not leave its values behind under a suffixed key",
    );
  });
});

describe("the socket is wired to the ingest path", () => {
  test("a datagram on the feedback port reaches the feedback map", async () => {
    // Every other test here calls receive() directly, which proves what the
    // method does and nothing about whether anything calls it. The socket's
    // "message" handler is one line, it is the only production caller, and
    // renaming the method it points at is exactly the edit that would quietly
    // sever it — leaving a manager that decodes perfectly and never hears
    // anything.
    //
    // The only packet this file puts on a wire. It goes to 127.0.0.1, to a
    // socket THIS PROCESS bound on a port the OS handed out moments ago.
    // Nothing on the LAN is addressed and no configured target is used.
    //
    // Sent repeatedly rather than once: the bind is asynchronous with no
    // callback to await from out here, and a datagram that arrives before the
    // socket is listening is simply gone. UDP has no retry, so the test is the
    // retry.
    const sender = dgram.createSocket("udp4");
    const packet = encodeMessage("/still/listening", [{ type: "i", value: 42 }]);
    try {
      const deadline = Date.now() + 3000;
      for (;;) {
        await new Promise<void>((resolve, reject) => {
          sender.send(packet, PORT, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
        });
        // Past the 200 ms feedback throttle, which the stored value does not
        // wait for but a subsequent read may as well not race.
        await new Promise((r) => setTimeout(r, 50));
        if (values()["*::/still/listening"] !== undefined) break;
        if (Date.now() > deadline) break;
      }
      assert.equal(
        values()["*::/still/listening"],
        42,
        `nothing arriving on udp/${PORT} reached the feedback map — is the socket's message handler still wired to receive()?`,
      );
    } finally {
      await new Promise<void>((resolve) => sender.close(resolve));
    }
  });
});
