// Q-SYS latency: the measured numbers, and the targets they are held to.
//
// The real fake Core on localhost, measured in real time (performance.now, real
// sockets): only setTimeout is mocked, to advance the hourly log line by hand.
// The bounds are the spec's targets (p95 write confirm under
// 100 ms; a Core change on qsys:values within 250 ms of the fake Core pushing it; that Core pushes at once, so
// this does not exercise the AutoPoll or meter rates), which
// are two to three orders of magnitude over what loopback takes, so a slow CI runner
// has headroom and a real regression (a write that waits on a poll, a broadcast held
// behind a timer) still fails. Every test carries its own budget so a hung wait
// fails fast instead of holding the suite.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  mock,
  test,
} from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-latency-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { addBroadcastListener, setNamedSubscriberCheck } =
  await import("../broadcaster.js");
const { FakeQrcServer } = await import("./fake-qrc-server.js");
const { QsysService } = await import("./qsys-service.js");
const { QsysWatch, watchChannel, QSYS_VALUES_CHANNEL } =
  await import("./qsys-watch.js");
const { QsysWriter, LATENCY_LINE_INTERVAL_MS } =
  await import("./qsys-write.js");
const { LatencyWindow, LATENCY_WINDOW } = await import("./qsys-latency.js");
const { qsysAllowlist } = await import("./qsys-allowlist-store.js");
const { qsysWriteLog } = await import("./qsys-write-log.js");
type QsysSettings = import("./qsys-settings.js").QsysSettings;

/**
 * A per-test budget. Not the runner's `timeout` option: that leaves its timer alive
 * after the test, holding the process open for the full budget. This one is cleared.
 */
const BUDGET_MS = 30_000;
function budget(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = realSetTimeout(
        () => reject(new Error(`test exceeded its ${BUDGET_MS} ms budget`)),
        BUDGET_MS,
      );
    });
    try {
      timer?.unref();
      await Promise.race([body(), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
}
/** The spec's targets. */
const WRITE_P95_MS = 100;
const CHANGE_MS = 250;

let fake: InstanceType<typeof FakeQrcServer>;
let fakePort = 0;
let svc: InstanceType<typeof QsysService>;
let watch: InstanceType<typeof QsysWatch>;
let writer: InstanceType<typeof QsysWriter>;
let subscriptionListeners: (() => void)[] = [];
const named = new Set<string>();
const valuePushes: { at: number; payload: unknown }[] = [];

// Captured before the mock below replaces it: the budget and the waits below are real time.
const realSetTimeout = globalThis.setTimeout;

before(() => {
  // Only setTimeout is mocked (as in qsys-write.test.ts), so the connection's keepalive and
  // dial timers never run on their own and the hourly line can be advanced by hand. I/O,
  // setImmediate and the fake Core's pushes keep real time.
  mock.timers.enable({ apis: ["setTimeout"] });
  setNamedSubscriberCheck((ch) => named.has(ch));
});
addBroadcastListener((channel, payload) => {
  if (channel === QSYS_VALUES_CHANNEL) valuePushes.push({ at: performance.now(), payload });
});
after(async () => {
  mock.timers.reset();
  setNamedSubscriberCheck(() => false);
  await qsysWriteLog.whenIdle();
  await fs.rm(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  named.clear();
  valuePushes.length = 0;
  fake = new FakeQrcServer();
  fake.components.set("Lobby_Mixer", [
    {
      Name: "gain",
      Type: "Float",
      Value: -10,
      String: "-10dB",
      Position: 0.5,
      Direction: "Read/Write",
      ValueMin: -100,
      ValueMax: 20,
    },
  ]);
  const port = (fakePort = await fake.start());
  svc = new QsysService();
  subscriptionListeners = [];
  watch = new QsysWatch(svc, (cb) => void subscriptionListeners.push(cb));
  writer = new QsysWriter(svc, watch);
  await qsysAllowlist.replace([
    {
      component: "Lobby_Mixer",
      control: "gain",
      label: "Gain",
      min: -100,
      max: 0,
      confirm: "none",
    },
  ]);
  const settings: QsysSettings = {
    host: "127.0.0.1",
    port,
    user: "",
    enabled: true,
    volunteerMeterHz: 10,
    staffMeterHz: 20,
  };
  svc.configure(settings, null);
  await until(() => svc.transport !== null, "connected");
  await watch.recompute();
  // A page is watching: the values group exists and has been read.
  watch.setPanels([
    {
      id: "p",
      kind: "staff",
      addresses: [{ component: "Lobby_Mixer", control: "gain" }],
    },
  ]);
  named.add(watchChannel("p"));
  for (const cb of subscriptionListeners) cb();
  await watch.recompute();
  await until(() => watch.ready(), "ready");
});

afterEach(async () => {
  writer.dispose();
  svc.stop();
  await fake.stop();
});

async function until(
  cond: () => boolean,
  what: string,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

const write = (value: number) =>
  writer.write({
    component: "Lobby_Mixer",
    control: "gain",
    value,
    panelId: "p",
    device: "192.0.2.10 Test/1",
    remote: "192.0.2.10",
  });

describe("write latency", () => {
  test(
    `200 writes confirm with a p95 under ${WRITE_P95_MS} ms`,
    budget(async () => {
      const own: number[] = [];
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        const r = await write(-50 + (i % 40));
        own.push(performance.now() - t0);
        assert.ok(r.ok, "a write was refused");
      }
      const stats = writer.latencyStats();
      assert.equal(stats.count, 200, "the writer did not time every write");
      assert.ok(
        stats.p95 !== null && stats.p95 > 0,
        `reported write p95 ${stats.p95} ms is not a measurement`,
      );
      assert.ok(
        stats.p95 !== null && stats.p95 < WRITE_P95_MS,
        `reported write p95 ${stats.p95} ms`,
      );
      own.sort((a, b) => a - b);
      const mine = own[Math.ceil(0.95 * own.length) - 1];
      assert.ok(mine < WRITE_P95_MS, `measured write p95 ${mine} ms`);
      // What the writer reports is what a caller waited, give or take the work around the send.
      assert.ok(
        stats.p95 <= mine + 1,
        `reported p95 ${stats.p95} ms exceeds the caller's ${mine} ms`,
      );
    }),
  );

  test(
    "a change at the Core reaches qsys:values within 250 ms",
    budget(async () => {
      // Settle first: a late push from the initial read must not stand in for the change.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      valuePushes.length = 0;
      const t0 = performance.now();
      fake.setControl("Lobby_Mixer", "gain", -33);
      await until(
        () => valuePushes.length > 0,
        "the change on qsys:values",
        CHANGE_MS * 4,
      );
      assert.match(
        JSON.stringify(valuePushes[0].payload),
        /-33(?!\d)/,
        "the first push after the change is not the change",
      );
      const took = valuePushes[0].at - t0;
      assert.ok(
        took < CHANGE_MS,
        `the change took ${took} ms to reach qsys:values`,
      );
    }),
  );
});

describe("the hourly line", () => {
  test(
    "one line per hour while connected, only if there were writes, never one per write",
    budget(async () => {
      const log = mock.method(console, "log", () => {});
      try {
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS);
        assert.equal(log.mock.calls.length, 0, "a line with no writes");
        for (let i = 0; i < 5; i++) await write(-40 + i);
        assert.equal(
          log.mock.calls.filter((c) =>
            String(c.arguments[0]).includes("write p95"),
          ).length,
          0,
          "a line per write",
        );
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS);
        const lines = log.mock.calls
          .map((c) => String(c.arguments[0]))
          .filter((l) => l.includes("write p95"));
        assert.equal(lines.length, 1);
        assert.match(
          lines[0],
          /^\[qsys\] write p95 \d+(\.\d)? ms \(5 writes\)$/,
        );
        // Nothing written since: the next hour is quiet.
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS);
        assert.equal(
          log.mock.calls.filter((c) =>
            String(c.arguments[0]).includes("write p95"),
          ).length,
          1,
        );
      } finally {
        log.mock.restore();
      }
    }),
  );

  test(
    "no line while the Core is away",
    budget(async () => {
      const log = mock.method(console, "log", () => {});
      try {
        await write(-20);
        svc.stop();
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS);
        assert.equal(
          log.mock.calls.filter((c) =>
            String(c.arguments[0]).includes("write p95"),
          ).length,
          0,
        );
      } finally {
        log.mock.restore();
      }
    }),
  );
});

const lines = (log: { mock: { calls: { arguments: unknown[] }[] } }) =>
  log.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("write p95"));

async function reconnect(): Promise<void> {
  svc.configure(
    { host: "127.0.0.1", port: fakePort, user: "", enabled: true, volunteerMeterHz: 10, staffMeterHz: 20 },
    null,
  );
  await until(() => svc.transport !== null, "reconnected");
  await watch.recompute();
  for (const cb of subscriptionListeners) cb();
  await watch.recompute();
  await until(() => watch.ready(), "ready again");
}

describe("the hourly timer across a disconnect", () => {
  test(
    "a disconnect clears the timer, and writes counted before it are reported by the next line",
    budget(async () => {
      const log = mock.method(console, "log", () => {});
      try {
        for (let i = 0; i < 3; i++) await write(-40 + i);
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS / 2);
        svc.stop();
        await reconnect();
        await write(-30);
        // The first timer was armed an hour before this tick; it must be gone.
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS / 2);
        assert.deepEqual(lines(log), [], "the timer armed before the disconnect still fired");
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS / 2);
        const got = lines(log);
        assert.equal(got.length, 1);
        assert.match(got[0], /\(4 writes\)$/, "the writes counted before the disconnect were dropped");
      } finally {
        log.mock.restore();
      }
    }),
  );

  test(
    "a line that comes due while the Core is away keeps the count for the next one",
    budget(async () => {
      const log = mock.method(console, "log", () => {});
      // A source with no disconnect hook: the timer is not cleared, so it fires with the Core away.
      const source = { transport: null as unknown, core: null, getCatalog: () => null };
      const w = new QsysWriter(source as never, watch);
      try {
        const note = (w as unknown as { noteConfirmed(ms: number): void }).noteConfirmed.bind(w);
        for (let i = 0; i < 3; i++) note(5);
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS);
        assert.deepEqual(lines(log), [], "a line while the Core was away");
        source.transport = {};
        note(5);
        mock.timers.tick(LATENCY_LINE_INTERVAL_MS);
        const got = lines(log);
        assert.equal(got.length, 1);
        assert.match(got[0], /\(4 writes\)$/, "the writes counted while away were discarded");
      } finally {
        w.dispose();
        log.mock.restore();
      }
    }),
  );
});

describe("LatencyWindow", () => {
  test("percentiles are nearest-rank and empty reads null", () => {
    const w = new LatencyWindow();
    assert.deepEqual(w.stats(), { count: 0, p50: null, p95: null });
    for (let i = 1; i <= 100; i++) w.record(i);
    assert.deepEqual(w.stats(), { count: 100, p50: 50, p95: 95 });
  });

  test(`holds at most ${LATENCY_WINDOW} samples and forgets the oldest`, () => {
    const w = new LatencyWindow();
    for (let i = 0; i < LATENCY_WINDOW; i++) w.record(1000);
    for (let i = 0; i < LATENCY_WINDOW; i++) w.record(1);
    assert.deepEqual(w.stats(), { count: LATENCY_WINDOW, p50: 1, p95: 1 });
  });

  test("ignores a sample that is not a duration", () => {
    const w = new LatencyWindow();
    w.record(NaN);
    w.record(-1);
    assert.equal(w.stats().count, 0);
  });
});
