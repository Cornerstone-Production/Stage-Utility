// "Say an outage once" — the integrations' first-failure line, owned by the base.
//
// Twelve integrations carried `if (this.attempt === 0) console.warn(...)`. The
// counter resets on every success, so an upstream that FLAPS — answers, fails,
// answers, fails — makes every failure a fresh "first failure" and writes a line
// per flap, indefinitely. repeat-log.ts documents the measured cost of exactly
// that rule (3,527 lines in five days from one integration). The base now keeps
// one OutageLog: the first failure of a run is news, the same failure is not, a
// long run is reminded every 15 minutes, and a recovery that HOLDS is said once.
//
// Driven through REAPER, the simplest poller: its one seam (`reaperDeps.fetch`)
// decides each poll's outcome, and setTimeout and Date are mocked so the
// back-off timer and the settle window can be walked without waiting.

import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";

import { reaperDeps, reaperService } from "./reaper-service.js";

const transport = "TRANSPORT\t0\t1.0\t0\t0:01.000\t1.1.00";
const realFetch = reaperDeps.fetch;
let up = false;

afterEach(() => {
  reaperDeps.fetch = realFetch;
  reaperService.configure("", 0);
  reaperService.stop();
});

/** Every console.warn and console.log line tagged [reaper], in order. */
function capture(t: TestContext): string[] {
  const lines: string[] = [];
  const { warn, log } = console;
  const keep = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.startsWith("[reaper]") && !line.startsWith("[reaper] polling")) lines.push(line);
  };
  console.warn = keep;
  console.log = keep;
  t.after(() => {
    console.warn = warn;
    console.log = log;
  });
  return lines;
}

/**
 * REAPER configured against a stub that is up or down as `up` says. `poll`
 * is one step: drop whatever timer the last poll queued, let `ms` pass, set the
 * stub up or down, and poll once — so each step is exactly one poll.
 */
async function start(t: TestContext): Promise<{ poll: (ms: number, isUp: boolean) => Promise<void> }> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  up = false;
  reaperDeps.fetch = (async () => {
    if (!up) throw new Error("connect ECONNREFUSED");
    return { ok: true, status: 200, text: async () => transport } as unknown as Response;
  }) as typeof fetch;
  reaperService.configure("reaper.example", 8080);
  await settle();
  const svc = reaperService as unknown as { connect(): Promise<void>; clearReconnect(): void };
  return {
    poll: async (ms, isUp) => {
      svc.clearReconnect();
      t.mock.timers.tick(ms);
      up = isUp;
      await svc.connect();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

test("an upstream that flaps writes one line for the outage, not one per flap", async (t) => {
  const lines = capture(t);
  const { poll } = await start(t); // the first poll fails
  for (let i = 0; i < 3; i++) {
    await poll(10_000, true); // answers once...
    await poll(10_000, false); // ...and fails again
  }
  assert.equal(lines.length, 1, `a flapping REAPER wrote ${lines.length} lines:\n${lines.join("\n")}`);
  assert.match(lines[0], /Can't reach reaper\.example:8080/);
});

test("a recovery that holds is said once, with the outage it ends", async (t) => {
  const lines = capture(t);
  const { poll } = await start(t);
  await poll(10_000, false); // a second failure, same outage
  await poll(10_000, true);
  assert.equal(lines.length, 1, "the recovery is not news until it has held");
  t.mock.timers.tick(2 * 60_000);
  await settle();
  assert.equal(lines.length, 2, `expected the outage and its recovery:\n${lines.join("\n")}`);
  assert.match(lines[1], /^\[reaper\] reachable again after 2 failed attempts/);
});

test("a long outage reminds, with the attempt count, every 15 minutes", async (t) => {
  const lines = capture(t);
  const { poll } = await start(t);
  for (let i = 0; i < 16; i++) await poll(60_000, false);
  assert.equal(lines.length, 2, `expected the first failure and one reminder:\n${lines.join("\n")}`);
  assert.match(lines[1], /still failing after \d+ attempts/);
});

// ── An integration that polls slower than the settle window ──────────────────
//
// Resi polls every two minutes with nobody watching. With a two-minute settle
// window, every good poll of a box failing on alternate polls outlasted the
// window: one "reachable again" and one fresh failure per flap — two lines
// where the old gate wrote one. The window has to outlast the slowest poll.

test("Resi: an account failing on alternate idle polls is one outage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { resiService } = await import("./resi-service.js");
  const realGlobalFetch = globalThis.fetch;
  let resiUp = false;
  globalThis.fetch = (async (input: unknown) => {
    if (!resiUp) throw new Error("connect ECONNREFUSED");
    const url = String(input);
    const body = url.endsWith("/auth/token")
      ? { access_token: "t", expires_in: 86_400 }
      : url.endsWith("/users/me")
        ? { customerId: "c1" }
        : [];
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  const lines: string[] = [];
  const { warn, log } = console;
  const keep = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.startsWith("[resi]") && !line.includes("polling") && !line.includes("broadcast list")) lines.push(line);
  };
  console.warn = keep;
  console.log = keep;
  t.after(() => {
    console.warn = warn;
    console.log = log;
    globalThis.fetch = realGlobalFetch;
    resiService.stop();
  });

  const svc = resiService as unknown as { connect(): Promise<void>; clearReconnect(): void };
  resiService.configure("someone", "pw"); // the first poll fails
  await settle();
  // Three flaps: twelve minutes, inside the 15-minute reminder.
  for (let i = 0; i < 3; i++) {
    for (const up of [true, false]) {
      svc.clearReconnect();
      t.mock.timers.tick(120_000); // the idle cadence
      resiUp = up;
      await svc.connect();
      await settle();
    }
  }
  assert.equal(lines.length, 1, `a Resi failing on alternate idle polls wrote ${lines.length} lines:\n${lines.join("\n")}`);
});

// ── OBS: one refused connect is one line, and one retry ──────────────────────
//
// The connect catch closed the adapter while it was still `this.adapter`, and
// close() fires onClose synchronously — which took the "connection dropped"
// path too: a second line ("connection closed — reconnecting") and a second
// retry queued over the first.

test("OBS: a refused connect writes one line and queues one retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const net = await import("node:net");
  const { obsService } = await import("./obs-service.js");
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as import("node:net").AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));

  const lines: string[] = [];
  const { warn } = console;
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.startsWith("[obs]")) lines.push(line);
  };
  const delays: number[] = [];
  const svc = obsService as unknown as { scheduleIn(ms: number): void };
  const real = svc.scheduleIn.bind(obsService);
  svc.scheduleIn = (ms: number) => {
    delays.push(ms);
    real(ms);
  };
  t.after(() => {
    console.warn = warn;
    delete (svc as { scheduleIn?: unknown }).scheduleIn;
    obsService.stop();
  });

  obsService.configure("127.0.0.1", port, null);
  const deadline = performance.now() + 5000;
  while (delays.length === 0 && performance.now() < deadline) await new Promise((r) => setImmediate(r));
  await settle();

  assert.equal(lines.length, 1, `one refused connect wrote ${lines.length} lines:\n${lines.join("\n")}`);
  assert.equal(delays.length, 1, `one refused connect queued ${delays.length} retries`);
});

/**
 * One flap of an integration that polls slower than two minutes: a failure,
 * a good poll `gapMs` later, and a failure `gapMs` after that. Returns the
 * tagged lines. The connect is driven by hand, one poll per step.
 */
async function slowFlap(
  t: TestContext,
  tag: string,
  svc: { connect(): Promise<void>; clearReconnect(): void },
  setUp: (up: boolean) => void,
  gapMs: number,
): Promise<string[]> {
  const lines: string[] = [];
  const { warn, log } = console;
  const keep = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.startsWith(`[${tag}] `) && !/polling|following/.test(line)) lines.push(line);
  };
  console.warn = keep;
  console.log = keep;
  t.after(() => {
    console.warn = warn;
    console.log = log;
  });
  for (const up of [true, false]) {
    svc.clearReconnect();
    t.mock.timers.tick(gapMs);
    setUp(up);
    await svc.connect();
    await settle();
  }
  return lines;
}

test("YouTube: a channel failing on alternate idle polls is one outage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { youtubeService } = await import("./youtube-service.js");
  const realGlobalFetch = globalThis.fetch;
  let ytUp = false;
  globalThis.fetch = (async () => {
    if (!ytUp) throw new Error("fetch failed");
    return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
  }) as typeof fetch;
  const quietLog = console.log;
  t.after(() => {
    console.log = quietLog;
    globalThis.fetch = realGlobalFetch;
    youtubeService.stop();
  });
  console.log = () => {};
  youtubeService.configure({ mode: "key", apiKey: "k", channel: "UCaaaaaaaaaaaaaaaaaaaaaa", clientId: "", clientSecret: "", refreshToken: "" });
  await settle(); // the first poll fails
  console.log = quietLog;
  const said = await slowFlap(
    t,
    "youtube",
    youtubeService as unknown as { connect(): Promise<void>; clearReconnect(): void },
    (up) => (ytUp = up),
    300_000, // the idle cadence
  );
  // The first failure's line came before capture began; nothing more may follow.
  assert.deepEqual(said, [], `one flap at the idle cadence wrote:\n${said.join("\n")}`);
});

test("Scores: an ESPN failing on alternate dormant polls is one outage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { scoresService } = await import("./scores-service.js");
  const realGlobalFetch = globalThis.fetch;
  let espnUp = false;
  globalThis.fetch = (async () => {
    if (!espnUp) throw new Error("fetch failed");
    return { ok: true, status: 200, json: async () => ({ events: [] }) } as unknown as Response;
  }) as typeof fetch;
  const { warn, log } = console;
  t.after(() => {
    console.warn = warn;
    console.log = log;
    globalThis.fetch = realGlobalFetch;
    scoresService.stop();
  });
  console.warn = () => {};
  console.log = () => {};
  scoresService.configure([{ league: "mlb", teamId: "1", displayName: "1", abbreviation: "1", logo: null, color: null }]);
  await settle(); // the first poll fails
  console.warn = warn;
  console.log = log;
  const said = await slowFlap(
    t,
    "scores",
    scoresService as unknown as { connect(): Promise<void>; clearReconnect(): void },
    (up) => (espnUp = up),
    30 * 60_000, // the dormant cadence
  );
  // An hour into the outage the failure is reminded; it is never "recovered".
  assert.deepEqual(
    said.filter((l) => !/still failing/.test(l)),
    [],
    `one flap at the dormant cadence was a recovery and a new outage:\n${said.join("\n")}`,
  );
});
