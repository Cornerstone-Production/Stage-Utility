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
const { QsysWriter, REFUSAL_LINE_INTERVAL_MS } = await import("./qsys-write.js");
const { qsysAllowlist, allowEntryFromCatalog } = await import("./qsys-allowlist-store.js");
const { qsysWriteLog, WRITE_LOG_CAP } = await import("./qsys-write-log.js");
type QsysSettings = import("./qsys-settings.js").QsysSettings;
type AllowEntry = import("./qsys-allowlist-store.js").AllowEntry;
type WriteRequest = import("./qsys-write.js").WriteRequest;
type QsysCatalog = import("./qsys-service.js").QsysCatalog;

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
const CHIME: AllowEntry = { component: "Paging", control: "chime", label: "Chime", min: null, max: null, confirm: "none" };
/** On the allowlist, not in the design. */
const GHOST: AllowEntry = { component: "Lobby_Mixer", control: "gone", label: "Gone", min: -10, max: 0, confirm: "none" };

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
  fake.components.set("Paging", [{ Name: "chime", Type: "Trigger", Value: 0, String: "", Position: 0, Direction: "Read/Write" }]);
  port = await fake.start();
  svc = new QsysService();
  watch = new QsysWatch(svc);
  writer = new QsysWriter(svc, watch);
  await qsysAllowlist.replace([GAIN, MUTE, LEVEL, CHIME, GHOST]);
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

  test("a write the Core refuses is a core-error, logged once, and not sent again", async () => {
    await connect();
    fake.failNext("Component.Set", 8);
    const before = (await qsysWriteLog.list()).entries.length;
    const warn = capture("warn");
    let r;
    try {
      r = await writer.write(req({ value: -20 }));
    } finally {
      warn.restore();
    }
    assert.equal(r.ok ? null : r.reason, "core-error");
    assert.ok(!r.ok && /the Core refused the write to Lobby_Mixer\/gain/.test(r.message), "the Core's refusal was not named");
    assert.equal(warn.lines.filter((l) => l.startsWith("[qsys] write refused (core-error)")).length, 1);
    const { entries } = await qsysWriteLog.list();
    assert.equal(entries.length - before, 1);
    assert.equal(entries[0].result, "core-error");
    assert.equal(entries[0].to, -20);
    await settle();
    assert.equal(sets().length, 1, "a refused write was retried");
  });

  test("a trigger takes no range and is sent as 1", async () => {
    await connect();
    const r = await writer.write(req({ component: "Paging", control: "chime", value: true }));
    assert.ok(r.ok, `a trigger with no range was refused: ${JSON.stringify(r)}`);
    assert.deepEqual((sets()[0].params as { Controls: unknown }).Controls, [{ Name: "chime", Value: 1 }]);
    const warn = capture("warn");
    try {
      const off = await writer.write(req({ component: "Paging", control: "chime", value: false }));
      assert.equal(off.ok ? null : off.reason, "bad-value");
    } finally {
      warn.restore();
    }
    assert.equal(sets().length, 1);
  });

  test("an allowlisted control missing from the design is refused before anything is sent", async () => {
    await connect();
    const warn = capture("warn");
    try {
      const r = await writer.write(req({ control: "gone", value: -5 }));
      assert.equal(r.ok ? null : r.reason, "core-error");
      assert.ok(!r.ok && /not in the Core's design/.test(r.message));
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

describe("review round 1", () => {
  const newest = async () => (await qsysWriteLog.list()).entries[0];

  test("a mid-gesture write that lands leaves no entry and no clamp line; the gesture's last write and every refusal do", async () => {
    await connect();
    // The log is at its cap by now, so count this test's own device.
    const drags = async () => (await qsysWriteLog.list()).entries.filter((e) => e.device === "198.51.100.1 Drag").length;
    const log = capture("log");
    const warn = capture("warn");
    try {
      for (const value of [-50, 4, 9]) {
        const r = await writer.write(req({ value, final: false, device: "198.51.100.1 Drag" }));
        assert.ok(r.ok);
      }
      assert.equal(await drags(), 0, "a mid-gesture write was logged");
      assert.ok(!log.lines.some((l) => l.includes("clamped")), "a mid-gesture clamp reached /log");
      assert.equal(sets().length, 3, "a mid-gesture write was not sent");

      const refused = await writer.write(req({ control: "nope", final: false, device: "198.51.100.1 Drag" }));
      assert.ok(!refused.ok);
      assert.equal((await newest()).result, "not-allowed", "a mid-gesture refusal was not logged");

      await writer.write(req({ value: 9, final: true, device: "198.51.100.1 Drag" }));
      assert.equal((await newest()).result, "clamped");
      assert.ok(log.lines.some((l) => l.includes("clamped from 9 to 0")));
      await writer.write(req({ value: -3, device: "198.51.100.1 Drag" }));
      assert.equal((await newest()).to, -3, "a write with no final flag was not logged");
    } finally {
      log.restore();
      warn.restore();
    }
  });

  test("a mid-gesture read-back mismatch is not logged; the final one is", async () => {
    await connect();
    fake.coerceSet = (_c, _n, v) => (typeof v === "number" ? v - 3 : v);
    const warn = capture("warn");
    try {
      await writer.write(req({ value: -20, final: false }));
      assert.equal(warn.lines.length, 0, warn.lines.join(" | "));
      await writer.write(req({ value: -20, final: true }));
      assert.equal(warn.lines.filter((l) => l.includes("read-back mismatch")).length, 1);
    } finally {
      warn.restore();
    }
  });

  test("offline refusal lines: once per state, again after a minute or a new episode, with what was held back", async () => {
    let clock = 1_000_000;
    const timed = new QsysWriter(svc, watch, () => clock);
    const warn = capture("warn");
    const offline = () => warn.lines.filter((l) => l.startsWith("[qsys] write refused (offline)"));
    try {
      for (let i = 0; i < 5; i++) assert.equal(((await timed.write(req())) as { reason?: string }).reason, "offline");
      assert.equal(offline().length, 1, "every offline refusal wrote a line");
      clock += REFUSAL_LINE_INTERVAL_MS - 1;
      await timed.write(req());
      assert.equal(offline().length, 1);
      clock += 1;
      await timed.write(req());
      assert.equal(offline().length, 2, "no line after a minute");
      assert.match(offline()[1], /\(5 more like it not logged\)$/);

      // A new episode: the Core came back, a write landed, the Core went again.
      await connect();
      await openPanel();
      assert.ok((await timed.write(req({ value: -12 }))).ok);
      await fake.dropClients();
      await until(() => svc.transport === null, "disconnect");
      await timed.write(req());
      assert.equal(offline().length, 3, "a new offline episode inside the minute was not logged");
    } finally {
      warn.restore();
    }
  });

  test("an offline refusal line is written again when the connection changes, though no write landed between", async () => {
    const t1 = { send: async () => undefined, onNotification: () => {}, close: () => {} };
    const t2 = { ...t1 };
    const source: { transport: typeof t1 | null; getCatalog: () => QsysCatalog | null } = { transport: null, getCatalog: () => null };
    const notReady = { ready: () => false, current: () => new Map() };
    const timed = new QsysWriter(source, notReady, () => 5_000_000);
    const warn = capture("warn");
    try {
      await timed.write(req());
      await timed.write(req());
      source.transport = t1; // reconnected, values not read yet
      await timed.write(req());
      await timed.write(req());
      source.transport = t2; // dropped and reconnected again
      await timed.write(req());
    } finally {
      warn.restore();
    }
    assert.equal(warn.lines.filter((l) => l.startsWith("[qsys] write refused (offline)")).length, 3);
  });

  test("a client looping on a refused write: one line per device a minute, one write-log entry counting the repeats", async () => {
    let clock = 2_000_000;
    const timed = new QsysWriter(svc, watch, () => clock);
    await connect();
    // The log may already be at its cap, so count this test's own devices.
    const mine = async () => (await qsysWriteLog.list()).entries.filter((e) => e.device.startsWith("203.0.113."));
    const warn = capture("warn");
    try {
      for (let i = 0; i < 10; i++) await timed.write(req({ control: "nope", device: "203.0.113.9 Loop" }));
      await timed.write(req({ control: "nope", device: "203.0.113.10 Other" }));
      const lines = () => warn.lines.filter((l) => l.startsWith("[qsys] write refused (not-allowed)"));
      assert.equal(lines().length, 2, "one line per device");
      const entries = await mine();
      assert.equal(entries.length, 2, "repeated refusals pushed entries out");
      const loop = entries.find((e) => e.device === "203.0.113.9 Loop")!;
      assert.equal(loop.repeats, 10);
      assert.equal(loop.lastAt, clock);
      clock += 60_001;
      await timed.write(req({ control: "nope", device: "203.0.113.9 Loop" }));
      assert.equal((await mine()).length, 3, "a repeat after the window joined an old entry");
      assert.equal(lines().length, 3);
    } finally {
      warn.restore();
    }
  });

  test("a live transport with no catalog yet refuses offline, not core-error", async () => {
    let sent = 0;
    const source = { transport: { send: async () => void sent++, onNotification: () => {}, close: () => {} }, getCatalog: (): QsysCatalog | null => null };
    const always = { ready: () => true, current: () => new Map() };
    const warn = capture("warn");
    try {
      const r = await new QsysWriter(source, always).write(req());
      assert.equal(r.ok ? null : r.reason, "offline");
    } finally {
      warn.restore();
    }
    assert.equal(sent, 0);
  });

  test("a dropped connection mid-write tells the page a fixed phrase and /log the reason", async () => {
    const catalog: QsysCatalog = { designCode: "d", components: [{ name: "Lobby_Mixer", type: "mixer", controls: fake.components.get("Lobby_Mixer")! }] };
    const source = {
      transport: { send: () => Promise.reject(new Error("connect ECONNRESET 192.0.2.50:1710")), onNotification: () => {}, close: () => {} },
      getCatalog: () => catalog,
    };
    const always = { ready: () => true, current: () => new Map() };
    const warn = capture("warn");
    let r;
    try {
      r = await new QsysWriter(source, always).write(req());
    } finally {
      warn.restore();
    }
    assert.ok(!r.ok);
    assert.equal(r.reason, "core-error");
    assert.ok(!r.message.includes("192.0.2.50"), `the Core's address reached the page: ${r.message}`);
    assert.ok(warn.lines.some((l) => l.includes("192.0.2.50:1710")), "the reason did not reach /log");
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
