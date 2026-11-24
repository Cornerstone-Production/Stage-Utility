import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { FakeQrcServer } from "./fake-qrc-server.js";
import { QrcClient, QrcError } from "./qrc-client.js";

let fake: FakeQrcServer;
let port: number;
const clients: QrcClient[] = [];
// Raw servers made inside a test, closed in afterEach so a failed assertion leaks nothing.
const rawServers: net.Server[] = [];
const rawSockets: net.Socket[] = [];

async function rawServer(onConnection: (s: net.Socket) => void): Promise<number> {
  const server = net.createServer((s) => {
    rawSockets.push(s);
    s.on("error", () => {});
    onConnection(s);
  });
  rawServers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}

beforeEach(async () => {
  fake = new FakeQrcServer();
  fake.components.set("Lobby_Mixer", [
    { Name: "gain", Type: "Float", Value: -10, String: "-10dB", Position: 0.5, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
  ]);
  port = await fake.start();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of rawSockets.splice(0)) s.destroy();
  for (const s of rawServers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  await fake.stop();
});

async function connect(timeoutMs?: number): Promise<QrcClient> {
  const c = await QrcClient.connect("127.0.0.1", port, timeoutMs ? { timeoutMs } : undefined);
  clients.push(c);
  return c;
}

test("frames each message with a trailing NUL and matches responses by numeric id", async () => {
  const c = await connect();
  const [a, b] = await Promise.all([
    c.send("StatusGet"),
    c.send("Component.GetControls", { Name: "Lobby_Mixer" }),
  ]);
  assert.equal((a as { DesignName: string }).DesignName, fake.status.DesignName);
  assert.equal((b as { Controls: unknown[] }).Controls.length, 1);
  assert.deepEqual(fake.received.map((r) => r.method).sort(), ["Component.GetControls", "StatusGet"]);
});

test("the wire carries NUL-terminated JSON-RPC 2.0 with numeric ids", async () => {
  const raw: Buffer[] = [];
  const p = await rawServer((s) => {
    s.on("data", (d) => {
      raw.push(d);
      s.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: true })}\0`);
    });
  });
  const c = await QrcClient.connect("127.0.0.1", p);
  await c.send("NoOp");
  c.close();
  const bytes = Buffer.concat(raw);
  assert.equal(bytes[bytes.length - 1], 0);
  const msg = JSON.parse(bytes.subarray(0, -1).toString());
  assert.equal(msg.jsonrpc, "2.0");
  assert.equal(typeof msg.id, "number");
  assert.equal(msg.method, "NoOp");
});

test("a split TCP chunk and two messages in one chunk both parse", async () => {
  const p = await rawServer((s) => {
    s.on("data", () => {
      const one = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "one" });
      const two = JSON.stringify({ jsonrpc: "2.0", id: 2, result: "two" });
      const three = JSON.stringify({ jsonrpc: "2.0", id: 3, result: "three" });
      // Message 1 split mid-JSON across two writes; 2 and 3 glued in a single chunk.
      s.write(one.slice(0, 10));
      setTimeout(() => {
        s.write(`${one.slice(10)}\0`);
        setTimeout(() => s.write(`${two}\0${three}\0`), 20);
      }, 20);
    });
  });
  const c = await QrcClient.connect("127.0.0.1", p);
  const results = await Promise.all([c.send("A"), c.send("B"), c.send("C")]);
  c.close();
  assert.deepEqual(results, ["one", "two", "three"]);
});

test("a multi-byte character split across two chunks decodes intact", async () => {
  const message = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "caf\u00e9 \u4e2d" })}\0`);
  const cut = message.indexOf(0xc3) + 1; // between the two bytes of the e-acute
  const p = await rawServer((s) => {
    s.on("data", () => {
      s.write(message.subarray(0, cut));
      setTimeout(() => s.write(message.subarray(cut)), 20);
    });
  });
  const c = await QrcClient.connect("127.0.0.1", p);
  clients.push(c);
  assert.equal(await c.send("A"), "caf\u00e9 \u4e2d");
});

test("a non-numeric error code becomes -1, never NaN", async () => {
  const p = await rawServer((s) => {
    s.on("data", () => s.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: "x", message: "bad" } })}\0`));
  });
  const c = await QrcClient.connect("127.0.0.1", p);
  clients.push(c);
  await assert.rejects(c.send("A"), (err: unknown) => err instanceof QrcError && err.code === -1);
});

test("a throwing onClose handler does not stop the next one or crash the process", async () => {
  const c = await connect();
  c.onClose(() => {
    throw new Error("boom");
  });
  const second = new Promise<Error | null>((resolve) => c.onClose(resolve));
  c.close();
  await second;
});

test("the fake survives an unparseable request and a refused group add keeps its slot free", async () => {
  const c = await connect();
  const raw = net.createConnection({ host: "127.0.0.1", port });
  rawSockets.push(raw);
  await new Promise<void>((r) => raw.once("connect", () => r()));
  raw.write("{not json\0");
  await c.send("NoOp"); // the fake is still serving
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      c.send("ChangeGroup.AddComponentControl", { Id: `g${i}`, Component: { Name: "Nope", Controls: [{ Name: "x" }] } }),
      (err: unknown) => err instanceof QrcError && err.code === 7,
    );
  }
  for (let i = 0; i < 4; i++) {
    await c.send("ChangeGroup.AddComponentControl", { Id: `ok${i}`, Component: { Name: "Lobby_Mixer", Controls: [{ Name: "gain" }] } });
  }
  await assert.rejects(
    c.send("ChangeGroup.AddComponentControl", { Id: "ok4", Component: { Name: "Lobby_Mixer", Controls: [{ Name: "gain" }] } }),
    (err: unknown) => err instanceof QrcError && err.code === 5,
  );
});

test("an error response rejects with QrcError carrying the code", async () => {
  const c = await connect();
  fake.failNext("Component.Set", 8);
  await assert.rejects(
    c.send("Component.Set", { Name: "Lobby_Mixer", Controls: [{ Name: "gain", Value: 1 }] }),
    (err: unknown) => err instanceof QrcError && err.code === 8,
  );
});

test("EngineStatus arrives through onNotification", async () => {
  // The fake pushes on accept; the handler is registered in the same tick connect() resolves.
  const c = await connect();
  const got = await new Promise<{ method: string; params: unknown }>((resolve) =>
    c.onNotification((method, params) => resolve({ method, params })),
  );
  assert.equal(got.method, "EngineStatus");
  assert.equal((got.params as { DesignCode: string }).DesignCode, fake.status.DesignCode);
});

test("socket close rejects every pending send and fires onClose", async () => {
  const c = await connect();
  const closed = new Promise<Error | null>((resolve) => c.onClose(resolve));
  // connect() resolves on the client side before the fake has accepted the socket;
  // one round trip guarantees the fake knows this client before it is told to drop it.
  await c.send("NoOp");
  fake.holdReplies = true;
  const pending = [c.send("StatusGet"), c.send("NoOp")];
  const settled = Promise.allSettled(pending);
  await fake.dropClients();
  const results = await settled;
  assert.ok(results.every((r) => r.status === "rejected"));
  await closed;
  await assert.rejects(c.send("NoOp"));
});

test("a send with no reply rejects after timeoutMs", async () => {
  const c = await connect(200);
  fake.holdReplies = true;
  const t0 = Date.now();
  await assert.rejects(c.send("NoOp"), /timed out/);
  assert.ok(Date.now() - t0 >= 180);
});

test("a receive buffer over 1 MB drops the socket", async () => {
  const p = await rawServer((s) => {
    s.on("data", () => s.write(Buffer.alloc(1024 * 1024 + 10, 0x61)));
  });
  const c = await QrcClient.connect("127.0.0.1", p);
  const closed = new Promise<Error | null>((resolve) => c.onClose(resolve));
  const pending = c.send("NoOp");
  await assert.rejects(pending, /buffer/);
  const err = await closed;
  assert.ok(err instanceof Error);
});

test("connect rejects when nothing listens", async () => {
  await fake.stop();
  await assert.rejects(QrcClient.connect("127.0.0.1", port));
});
