// Transport tests. These NEVER touch real hardware — every test connects to a local
// fake TCP server that captures bytes. Production runs live switchers; a test that
// dials one is a broken test.

import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach } from "node:test";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-rosstalk-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { rosstalkManager } = await import("./rosstalk-manager.js");

/** A fake RossTalk device: accepts TCP, records every byte, never replies. */
function fakeDevice() {
  const received: string[] = [];
  const server = net.createServer((sock) => {
    sock.on("data", (b) => received.push(b.toString("utf8")));
  });
  return {
    received,
    listen: () =>
      new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let device: ReturnType<typeof fakeDevice>;
let port: number;

before(async () => {
  device = fakeDevice();
  port = await device.listen();
  await rosstalkManager.init();
});
after(async () => {
  rosstalkManager.stopAll();
  await device.close();
  await fs.rm(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  device.received.length = 0;
});

/** Add an enabled Carbonite target pointing at the fake device, and settle. */
async function target(family: "carbonite" | "ultrix" = "carbonite") {
  const list = await rosstalkManager.addTarget({ name: "fake" });
  const t = list[list.length - 1];
  await rosstalkManager.updateTarget({
    id: t.id,
    patch: { enabled: true, config: { host: "127.0.0.1", port, family } },
  });
  await new Promise((r) => setTimeout(r, 120));
  return t.id;
}

describe("send", () => {
  test("writes the formatted line terminated with exactly one CRLF", async () => {
    await rosstalkManager.setSimulate(false);
    const id = await target();
    const r = await rosstalkManager.send(id, { commandId: "cc", params: { bank: 1, cc: 5 } });

    assert.equal(r.line, "CC 1:05");
    assert.equal(r.simulated, false);
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(device.received.join(""), "CC 1:05\r\n");
  });

  test("a raw command is sanitised to exactly one line", async () => {
    await rosstalkManager.setSimulate(false);
    const id = await target();
    await rosstalkManager.send(id, { raw: "FTB\r\nMECUT ME:1" });
    await new Promise((res) => setTimeout(res, 80));
    // One CRLF total — the injected one was stripped, not forwarded.
    assert.equal((device.received.join("").match(/\r\n/g) || []).length, 1);
  });

  test("simulate mode sends NOTHING", async () => {
    await rosstalkManager.setSimulate(true);
    const id = await target();
    const r = await rosstalkManager.send(id, { commandId: "ftb", params: {} });

    assert.equal(r.simulated, true);
    assert.equal(r.line, "FTB");
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(device.received.join(""), "", "simulate must not put a byte on the wire");
  });

  test("a command from the wrong family is rejected before any write", async () => {
    await rosstalkManager.setSimulate(false);
    const id = await target("ultrix");
    await assert.rejects(
      () => rosstalkManager.send(id, { commandId: "cc", params: { bank: 1, cc: 5 } }),
      /family|carbonite/i,
    );
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(device.received.join(""), "");
  });

  test("an invalid parameter is rejected before any write", async () => {
    await rosstalkManager.setSimulate(false);
    const id = await target();
    await assert.rejects(() => rosstalkManager.send(id, { commandId: "cc", params: { bank: 1 } }), /cc/i);
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(device.received.join(""), "");
  });

  test("an unknown target throws", async () => {
    await assert.rejects(() => rosstalkManager.send("nope", { commandId: "ftb", params: {} }), /unknown target/i);
  });
});

describe("targets", () => {
  test("a new target is disabled and defaults to port 7788", async () => {
    const list = await rosstalkManager.addTarget({ name: "t" });
    const t = list[list.length - 1];
    assert.equal(t.enabled, false, "a new target must not dial out on its own");
    assert.equal(t.config.port, 7788);
  });

  test("test connects and sends nothing", async () => {
    const id = await target();
    const r = await rosstalkManager.testTarget({ id });
    assert.equal(r.ok, true);
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(device.received.join(""), "", "a probe would be a real command here");
  });

  test("removeTarget drops it from the list", async () => {
    const id = await target();
    const after = await rosstalkManager.removeTarget({ id });
    assert.ok(!after.some((t) => t.id === id));
  });
});
