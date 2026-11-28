// RossTalk and TSL are OUTPUTS: nothing subscribes to them, so the shared
// window-aware cap would read them as dormant and stretch a retry toward 30
// minutes. Both keep a fixed 30 s ceiling on purpose. They used to get it by
// overriding scheduleReconnect with a private counter of their own, which left
// the base's attempt counter at 0 for good — so RossTalk's "say the first
// failure" line fired on EVERY retry, every 30 s, for as long as a switcher was
// off.
//
// Real sockets against a port nothing listens on, so the failure is the one
// production sees (ECONNREFUSED), with setTimeout mocked so the back-off can be
// walked without waiting it out.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, test, type TestContext } from "node:test";
import { until } from "./fixtures/within.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-output-reconnect-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RossTalkConnection } = await import("./rosstalk-manager.js");
const { tslService } = await import("./tsl-service.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** A port that refuses: bound, read, and closed again. */
async function refusingPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** Capture console.warn lines tagged `[tag]` for the life of the test. */
function warnsTagged(t: TestContext, tag: string): string[] {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.startsWith(`[${tag}]`)) lines.push(line);
  };
  t.after(() => {
    console.warn = real;
  });
  return lines;
}

/** Walk `failures` refused connects, firing each queued retry by hand.
 *  `delays` is every delay the integration handed to scheduleIn. */
async function walk(t: TestContext, delays: number[], failures: number): Promise<void> {
  for (let i = 1; i <= failures; i++) {
    await until(() => delays.length >= i, `failure ${i} to queue a retry`);
    if (i < failures) t.mock.timers.tick(delays[i - 1]);
  }
}

const CEILING_STEPS = [3000, 6000, 12000, 24000, 30000, 30000];

test("RossTalk: an unreachable switcher is logged once per outage, not on every retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const port = await refusingPort();
  const warns = warnsTagged(t, "rosstalk");

  const delays: number[] = [];
  class Probed extends RossTalkConnection {
    protected override scheduleIn(ms: number): void {
      delays.push(ms);
      super.scheduleIn(ms);
    }
  }
  const conn = new Probed("probe", () => {});
  t.after(() => conn.stop());
  conn.configure("127.0.0.1", port);

  await walk(t, delays, CEILING_STEPS.length);

  assert.deepEqual(delays, CEILING_STEPS, "the fixed 30 s ceiling is deliberate and must survive");
  assert.equal(
    warns.length,
    1,
    `${CEILING_STEPS.length} refused connects wrote ${warns.length} lines:\n${warns.join("\n")}`,
  );
});

test("TSL: the same fixed 30 s ceiling, and the outage reaches the log once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const port = await refusingPort();
  const warns = warnsTagged(t, "tsl");

  const delays: number[] = [];
  const svc = tslService as unknown as { scheduleIn(ms: number): void };
  const real = svc.scheduleIn.bind(tslService);
  svc.scheduleIn = (ms: number) => {
    delays.push(ms);
    real(ms);
  };
  t.after(() => {
    tslService.stop();
    delete (svc as { scheduleIn?: unknown }).scheduleIn;
  });
  tslService.configure("127.0.0.1", port, []);

  await walk(t, delays, CEILING_STEPS.length);

  assert.deepEqual(delays, CEILING_STEPS);
  // TSL only reported the state, and the integration manager stores it without
  // logging, so a dark tally output said nothing at all in /log.
  assert.equal(warns.length, 1, `${CEILING_STEPS.length} refused connects wrote ${warns.length} lines:\n${warns.join("\n")}`);
  assert.match(warns[0], /unreachable/);
});

// A restart destroys the old socket, and its `close` arrives AFTER start() has
// set `running` back to true — so it took the "dropped, reconnect" path on the
// new run, and the reconnect opened a second socket over the live one, held
// for the life of the process. The read-after-await guard's event-handler twin.

/** A switcher that counts the connections it accepts and holds open. */
async function countingSwitcher(t: TestContext): Promise<{ port: number; accepted: () => number; open: Set<net.Socket> }> {
  const open = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((s) => {
    accepted++;
    open.add(s);
    s.on("close", () => open.delete(s));
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of open) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { port: (server.address() as net.AddressInfo).port, accepted: () => accepted, open };
}

/** Configure twice (a settings save), then fire any reconnect a stale close queued. */
async function restartAgainst(
  t: TestContext,
  sw: Awaited<ReturnType<typeof countingSwitcher>>,
  configure: () => void,
  connected: () => number,
): Promise<void> {
  configure();
  await until(() => connected() === 1 && sw.accepted() === 1, "the first socket");
  configure();
  // The new socket is up and the switcher has seen the old one close.
  await until(() => connected() === 2 && sw.accepted() === 2 && sw.open.size === 1, "the restart");
  t.mock.timers.tick(30_000);
  // Expected to time out: a stray reconnect to localhost lands in milliseconds.
  await until(() => sw.accepted() > 2 || sw.open.size !== 1, "a stray reconnect", 300).catch(() => {});
}

test("RossTalk: a restart leaves one socket open, not two", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sw = await countingSwitcher(t);
  const states: string[] = [];
  const conn = new RossTalkConnection("restart", (s) => states.push(s));
  t.after(() => conn.stop());

  await restartAgainst(t, sw, () => conn.configure("127.0.0.1", sw.port), () => states.filter((s) => s === "connected").length);

  assert.equal(sw.accepted(), 2, `one restart dialled the switcher ${sw.accepted()} times`);
  assert.equal(sw.open.size, 1, `one restart left ${sw.open.size} sockets open on the switcher`);
});

test("TSL: a restart leaves one socket open, and the new one still sending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sw = await countingSwitcher(t);
  const states: string[] = [];
  tslService.setConnectionListener((s) => states.push(s));
  t.after(() => {
    tslService.setConnectionListener(() => {});
    tslService.stop();
  });

  await restartAgainst(t, sw, () => tslService.configure("127.0.0.1", sw.port, []), () => states.filter((s) => s === "connected").length);

  assert.equal(sw.accepted(), 2, `one restart dialled the multiviewer ${sw.accepted()} times`);
  assert.equal(sw.open.size, 1, `one restart left ${sw.open.size} sockets open on the multiviewer`);
  assert.equal(
    (tslService as unknown as { connected: boolean }).connected,
    true,
    "the old socket's close marked the live one disconnected",
  );
});

test("RossTalk: a queued reconnect does not hold the process open", async (t) => {
  // Real timers: the property is the timer's ref, which a mock does not model.
  const port = await refusingPort();
  warnsTagged(t, "rosstalk");
  const delays: number[] = [];
  class Probed extends RossTalkConnection {
    protected override scheduleIn(ms: number): void {
      delays.push(ms);
      super.scheduleIn(ms);
    }
    get pending(): NodeJS.Timeout | null {
      return (this as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer;
    }
  }
  const conn = new Probed("unref", () => {});
  t.after(() => conn.stop());
  conn.configure("127.0.0.1", port);
  await until(() => delays.length >= 1, "the first retry to queue");

  assert.ok(conn.pending, "a retry is queued");
  assert.equal(conn.pending.hasRef(), false, "a queued RossTalk reconnect holds the process open");
});
