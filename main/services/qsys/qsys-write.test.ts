// The write path, run against a real QsysService and QsysWatch talking to the
// fake Core, with the allowlist and write log in a temporary data directory.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-write-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { setNamedSubscriberCheck, subscriptionsChanged } = await import("../broadcaster.js");
const { FakeQrcServer } = await import("./fake-qrc-server.js");
const { QsysService } = await import("./qsys-service.js");
const { QsysWatch, watchChannel } = await import("./qsys-watch.js");
const { QsysWriter } = await import("./qsys-write.js");
const { qsysAllowlist, allowEntryFromCatalog } = await import("./qsys-allowlist-store.js");
const { qsysWriteLog, WRITE_LOG_CAP } = await import("./qsys-write-log.js");
type QsysSettings = import("./qsys-settings.js").QsysSettings;
type AllowEntry = import("./qsys-allowlist-store.js").AllowEntry;
type WriteRequest = import("./qsys-write.js").WriteRequest;

let fake: InstanceType<typeof FakeQrcServer>;
let port: number;
let svc: InstanceType<typeof QsysService>;
let watch: InstanceType<typeof QsysWatch>;
let writer: InstanceType<typeof QsysWriter>;
const named = new Set<string>();

const settings = (): QsysSettings => ({ host: "127.0.0.1", port, user: "", enabled: true, volunteerMeterHz: 10, staffMeterHz: 20 });

const GAIN: AllowEntry = { component: "Lobby_Mixer", control: "gain", label: "Lobby gain", min: -100, max: 0, confirm: "none" };
const MUTE: AllowEntry = { component: "Lobby_Mixer", control: "mute", label: "Lobby mute", min: null, max: null, confirm: "hold" };
const LEVEL: AllowEntry = { component: "Zone 1", control: "level", label: "Zone level", min: null, max: null, confirm: "none" };

const req = (over: Partial<WriteRequest> = {}): WriteRequest => ({
  component: "Lobby_Mixer",
  control: "gain",
  value: -10,
  panelId: "panel-a",
  device: "192.0.2.10 TestBrowser/1.0",
  ...over,
});

before(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  setNamedSubscriberCheck((ch) => named.has(ch));
});
after(async () => {
  mock.timers.reset();
  setNamedSubscriberCheck(() => false);
  await qsysWriteLog.whenIdle();
  await fs.rm(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  named.clear();
  fake = new FakeQrcServer();
  fake.components.set("Lobby_Mixer", [
    { Name: "gain", Type: "Float", Value: -10, String: "-10dB", Position: 0.5, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
    { Name: "mute", Type: "Boolean", Value: false, String: "false", Position: 0, Direction: "Read/Write" },
  ]);
  // A numeric control the Core reports no range for.
  fake.components.set("Zone 1", [{ Name: "level", Type: "Float", Value: 3, String: "3", Position: 0.3, Direction: "Read/Write" }]);
  port = await fake.start();
  svc = new QsysService();
  watch = new QsysWatch(svc);
  writer = new QsysWriter(svc, watch);
  await qsysAllowlist.replace([GAIN, MUTE, LEVEL]);
});

afterEach(async () => {
  watch.dispose();
  svc.stop();
  await fake.stop();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 2000; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}; fake saw ${fake.received.map((r) => r.method).join(",")}`);
}

async function connect(): Promise<void> {
  svc.configure(settings(), null);
  await until(() => svc.transport !== null, "connected");
  await watch.recompute();
}

/** Register panel-a on gain and show it, so a change group (and an Invalidate after a reconnect) exists. */
async function openPanel(): Promise<void> {
  watch.setPanels([{ id: "panel-a", kind: "staff", addresses: [{ component: "Lobby_Mixer", control: "gain" }] }]);
  named.add(watchChannel("panel-a"));
  subscriptionsChanged();
  await watch.recompute();
  await settle();
}

const sets = () => fake.received.filter((r) => r.method === "Component.Set");

function capture(method: "warn" | "log") {
  const lines: string[] = [];
  const m = mock.method(console, method, (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => m.mock.restore() };
}

describe("writeControl", () => {
  test("refuses a control not on the allowlist", async () => {
    await connect();
    const warn = capture("warn");
    try {
      const r = await writer.write(req({ control: "gain_2" }));
      assert.deepEqual(r.ok ? null : r.reason, "not-allowed");
      assert.ok(warn.lines.some((l) => l.startsWith("[qsys] write refused (not-allowed)")), `no [qsys] line: ${warn.lines.join(" | ")}`);
    } finally {
      warn.restore();
    }
    assert.equal(sets().length, 0, "a control off the allowlist reached the Core");
  });

  test("refuses a numeric write to an entry with no range", async () => {
    await connect();
    const warn = capture("warn");
    try {
      const r = await writer.write(req({ component: "Zone 1", control: "level", value: 1 }));
      assert.equal(r.ok ? null : r.reason, "no-range");
    } finally {
      warn.restore();
    }
    assert.equal(sets().length, 0);
  });

  test("clamps to max and reports clamped", async () => {
    await connect();
    const log = capture("log");
    let r;
    try {
      r = await writer.write(req({ value: 6 }));
    } finally {
      log.restore();
    }
    assert.equal(sets().length, 1);
    const params = sets()[0].params as { Controls: { Name: string; Value: unknown }[] };
    assert.deepEqual(params.Controls, [{ Name: "gain", Value: 0 }]);
    assert.ok(r.ok);
    assert.equal(r.clamped, true);
    assert.equal(r.value, 0);
    assert.ok(log.lines.some((l) => l.includes("clamped from 6 to 0")), "a clamped write was not logged");
  });

  test("writes with ResponseValues and returns the Core's value", async () => {
    await connect();
    const r = await writer.write(req({ value: -20 }));
    assert.deepEqual(sets()[0].params, { Name: "Lobby_Mixer", Controls: [{ Name: "gain", Value: -20 }], ResponseValues: true });
    assert.deepEqual(r, { ok: true, value: -20, string: "-20dB", position: 80 / 120, clamped: false });
    const b = await writer.write(req({ control: "mute", value: true }));
    assert.deepEqual(b, { ok: true, value: true, string: "true", position: 1, clamped: false });
  });

  test("a read-back that differs from the sent value logs a mismatch", async () => {
    await connect();
    fake.coerceSet = (_c, _n, v) => (typeof v === "number" ? v - 3 : v);
    const warn = capture("warn");
    let r;
    try {
      r = await writer.write(req({ value: -20 }));
    } finally {
      warn.restore();
    }
    assert.ok(r.ok, "a write the Core took was reported as failed");
    assert.equal(r.value, -23, "the caller was not given the Core's value");
    assert.ok(
      warn.lines.some((l) => l.startsWith("[qsys] read-back mismatch on Lobby_Mixer/gain: sent -20, the Core holds -23")),
      `no mismatch line: ${warn.lines.join(" | ")}`,
    );
    assert.equal((await qsysWriteLog.list()).entries[0].result, "mismatch");
    // Within the tolerance is the same value, and says nothing.
    fake.coerceSet = (_c, _n, v) => (typeof v === "number" ? v + 0.001 : v);
    const quiet = capture("warn");
    try {
      await writer.write(req({ value: -30 }));
    } finally {
      quiet.restore();
    }
    assert.deepEqual(quiet.lines, []);
  });

  test("refuses while reconnecting and never replays later", async () => {
    await connect();
    await openPanel();
    await fake.dropClients();
    await until(() => svc.transport === null, "disconnect");
    const warn = capture("warn");
    try {
      const r = await writer.write(req({ value: -50 }));
      assert.equal(r.ok ? null : r.reason, "offline");
    } finally {
      warn.restore();
    }
    mock.timers.tick(3_000);
    await until(() => svc.transport !== null, "reconnected");
    await until(() => watch.ready(), "re-read");
    await settle();
    assert.equal(sets().length, 0, "a write refused while reconnecting reached the Core later");
    assert.equal(fake.components.get("Lobby_Mixer")![0].Value, -10);
  });

  test("after the Core reconnects, writes are refused until values are re-read (Invalidate answered)", async () => {
    await connect();
    await openPanel();
    await fake.dropClients();
    await until(() => svc.transport === null, "disconnect");
    fake.failNext("ChangeGroup.Invalidate", -32604);
    const warn = capture("warn");
    try {
      mock.timers.tick(3_000);
      await until(() => svc.transport !== null, "reconnected");
      await until(() => fake.received.some((r) => r.method === "ChangeGroup.Invalidate"), "refused Invalidate");
      await settle();
      assert.ok(svc.transport, "the transport is back");
      const early = await writer.write(req({ value: -40 }));
      assert.equal(early.ok ? null : early.reason, "offline", "a write landed before the Core's values were re-read");
      assert.equal(sets().length, 0);
      mock.timers.tick(1_000);
      await until(() => watch.ready(), "retry completes the rebuild");
    } finally {
      warn.restore();
    }
    const late = await writer.write(req({ value: -40 }));
    assert.ok(late.ok, "a fresh write after the re-read was refused");
    assert.equal(sets().length, 1, "only the fresh write was sent");
  });

  test("rejects wrong types: string to a gain, NaN, Infinity", async () => {
    await connect();
    const warn = capture("warn");
    try {
      for (const value of ["loud", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, true] as const) {
        const r = await writer.write(req({ value }));
        assert.equal(r.ok ? null : r.reason, "bad-value", `${String(value)} was not refused`);
      }
      const r = await writer.write(req({ control: "mute", value: 1 }));
      assert.equal(r.ok ? null : r.reason, "bad-value", "a number was written to a boolean");
    } finally {
      warn.restore();
    }
    assert.equal(sets().length, 0);
  });

  test("records one write-log entry per call with device and panel", async () => {
    await connect();
    const before = (await qsysWriteLog.list()).entries.length;
    const warn = capture("warn");
    try {
      await writer.write(req({ value: -15, panelId: "panel-a", device: "192.0.2.10 iPad" }));
      await writer.write(req({ value: 9, panelId: null, device: "192.0.2.11 Laptop" }));
      await writer.write(req({ control: "nope", device: "192.0.2.12 Phone" }));
    } finally {
      warn.restore();
    }
    const { entries } = await qsysWriteLog.list();
    assert.equal(entries.length - before, 3, "not one entry per call");
    const [refused, clamped, plain] = entries;
    assert.deepEqual(
      { ...plain, at: 0 },
      { at: 0, panelId: "panel-a", device: "192.0.2.10 iPad", component: "Lobby_Mixer", control: "gain", from: null, to: -15, result: "ok" },
    );
    assert.equal(clamped.panelId, null);
    assert.equal(clamped.device, "192.0.2.11 Laptop");
    assert.equal(clamped.to, 0);
    assert.equal(clamped.result, "clamped");
    assert.equal(refused.result, "not-allowed");
    assert.equal(refused.device, "192.0.2.12 Phone");
    // `from` is the Core's value as the watch last read it.
    await openPanel();
    await writer.write(req({ value: -12 }));
    assert.equal((await qsysWriteLog.list()).entries[0].from, 0);
  });

  test("the write log keeps the newest 2000 entries, in memory and on disk", async () => {
    for (let i = 0; i < WRITE_LOG_CAP + 5; i++) {
      await qsysWriteLog.add({ at: i, panelId: null, device: "d", component: "c", control: "n", from: null, to: i, result: "ok" });
    }
    const { entries, saveError } = await qsysWriteLog.list();
    assert.equal(entries.length, WRITE_LOG_CAP);
    assert.equal(entries[0].at, WRITE_LOG_CAP + 4);
    assert.equal(saveError, null);
    await qsysWriteLog.whenIdle();
    const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "qsys-write-log.json"), "utf8")) as { at: number }[];
    assert.equal(onDisk.length, WRITE_LOG_CAP);
    assert.equal(onDisk[0].at, WRITE_LOG_CAP + 4);
  });
});

describe("allowEntryFromCatalog", () => {
  test("takes the Core's range, and none when the Core reports none", () => {
    const gain = fake.components.get("Lobby_Mixer")![0];
    assert.deepEqual(allowEntryFromCatalog(gain, "Lobby_Mixer"), {
      component: "Lobby_Mixer",
      control: "gain",
      label: "Lobby_Mixer gain",
      min: -100,
      max: 20,
      confirm: "none",
    });
    const level = fake.components.get("Zone 1")![0];
    const e = allowEntryFromCatalog(level, "Zone 1");
    assert.equal(e.min, null);
    assert.equal(e.max, null);
  });
});
