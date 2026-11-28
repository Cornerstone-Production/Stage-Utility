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

/** REAPER configured against a stub that is up or down as `up` says. */
async function start(t: TestContext): Promise<{ poll: () => Promise<void> }> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  up = false;
  reaperDeps.fetch = (async () => {
    if (!up) throw new Error("connect ECONNREFUSED");
    return { ok: true, status: 200, text: async () => transport } as unknown as Response;
  }) as typeof fetch;
  reaperService.configure("reaper.example", 8080);
  await settle();
  const svc = reaperService as unknown as { connect(): Promise<void> };
  return { poll: () => svc.connect() };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

test("an upstream that flaps writes one line for the outage, not one per flap", async (t) => {
  const lines = capture(t);
  const { poll } = await start(t); // the first poll fails
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(10_000);
    up = true;
    await poll(); // answers once...
    t.mock.timers.tick(10_000);
    up = false;
    await poll(); // ...and fails again
  }
  assert.equal(lines.length, 1, `a flapping REAPER wrote ${lines.length} lines:\n${lines.join("\n")}`);
  assert.match(lines[0], /Can't reach reaper\.example:8080/);
});

test("a recovery that holds is said once, with the outage it ends", async (t) => {
  const lines = capture(t);
  const { poll } = await start(t);
  t.mock.timers.tick(10_000);
  await poll(); // a second failure, same outage
  up = true;
  t.mock.timers.tick(10_000);
  await poll();
  assert.equal(lines.length, 1, "the recovery is not news until it has held");
  t.mock.timers.tick(2 * 60_000);
  await settle();
  assert.equal(lines.length, 2, `expected the outage and its recovery:\n${lines.join("\n")}`);
  assert.match(lines[1], /^\[reaper\] reachable again after \d+ failed attempts/);
});

test("a long outage reminds, with the attempt count, every 15 minutes", async (t) => {
  const lines = capture(t);
  const { poll } = await start(t);
  for (let i = 0; i < 16; i++) {
    t.mock.timers.tick(60_000);
    await poll();
  }
  assert.equal(lines.length, 2, `expected the first failure and one reminder:\n${lines.join("\n")}`);
  assert.match(lines[1], /still failing after \d+ attempts/);
});
