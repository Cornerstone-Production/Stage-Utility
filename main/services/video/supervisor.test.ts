import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-supervisor-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { relayDir } = await import("./acquire.js");
const { RelaySupervisor, restartDelayMs } = await import("./supervisor.js");
import type { PsLookup, SpawnImpl, SupervisorStatus } from "./supervisor.js";

// No test here ever spawns the real MediaMTX binary: every RelaySupervisor
// below is built with a fake spawnImpl (an EventEmitter standing in for a
// ChildProcess, with real PassThrough streams for stdout/stderr) and a fake
// psImpl, so the leftover-pid check never shells out to the host's `ps`
// either. See supervisor.test.ts's sibling in the real-binary section of the
// task report for the one run against the real binary, done outside this
// suite.

const START = Date.UTC(2026, 8, 28, 12, 0, 0);

/** Lets a readline 'line' event, queued from a stream write, actually fire
 *  before the next assertion — mock.timers fakes setTimeout/Date, not the
 *  stream/microtask machinery readline runs on. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Structurally satisfies SpawnImpl's SupervisedChild return type (an
 * EventEmitter with pid/stdout/stderr/kill), but typed with the concrete
 * PassThrough streams so a test can write() to them directly, and with
 * killCalls so a test can assert what stop() actually sent.
 */
interface FakeChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: NodeJS.Signals | number): boolean;
  killCalls: Array<NodeJS.Signals | number | undefined>;
}

function makeFakeChild(pid: number): FakeChild {
  const killCalls: Array<NodeJS.Signals | number | undefined> = [];
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killCalls,
    kill(signal?: NodeJS.Signals | number): boolean {
      killCalls.push(signal);
      return true;
    },
  });
}

/** A spawnImpl that records every fake child it hands out, in spawn order. */
function fakeSpawn(): { spawnImpl: SpawnImpl; children: FakeChild[] } {
  const children: FakeChild[] = [];
  let nextPid = 1000;
  const spawnImpl: SpawnImpl = () => {
    const child = makeFakeChild(nextPid++);
    children.push(child);
    return child;
  };
  return { spawnImpl, children };
}

const neverLeftover: PsLookup = async () => null;

function enableClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
}

async function resetRelayDir(): Promise<void> {
  await fs.rm(relayDir(), { recursive: true, force: true });
}

beforeEach(resetRelayDir);
afterEach(resetRelayDir);

describe("restartDelayMs", () => {
  it("is 1 s doubling on every attempt, capped at 60 s", () => {
    assert.equal(restartDelayMs(0), 1000);
    assert.equal(restartDelayMs(1), 2000);
    assert.equal(restartDelayMs(2), 4000);
    assert.equal(restartDelayMs(3), 8000);
    assert.equal(restartDelayMs(5), 32000);
    assert.equal(restartDelayMs(6), 60000, "1000 * 2^6 = 64000, over the cap");
    assert.equal(restartDelayMs(19), 60000, "it never gives up, and never grows past the cap either");
  });
});

describe("RelaySupervisor", () => {
  it("runs, then fails with the last ERR line as the reason, and respawns after the 1 s backoff", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });

    await sup.start("mediamtx", "config.yml");
    assert.deepEqual(sup.status(), { state: "running", since: START } satisfies SupervisorStatus);
    assert.equal(children.length, 1);

    children[0].stderr.write('2026/09/28 12:00:00 ERR json: unknown field "rtsps"\n');
    await settle();

    children[0].emit("exit", 1, null);
    assert.deepEqual(sup.status(), {
      state: "failing",
      reason: 'json: unknown field "rtsps"',
      retryAt: START + 1000,
    } satisfies SupervisorStatus);

    t.mock.timers.tick(1000);
    assert.equal(children.length, 2, "the 1 s backoff must end in another spawn");
    assert.deepEqual(sup.status(), { state: "running", since: START + 1000 } satisfies SupervisorStatus);
  });

  it("backs off 1, 2, 4 s on quick repeats, and after 20 exits still spawns again at the 60 s cap", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");

    const delays: number[] = [];
    for (let i = 0; i < 20; i++) {
      const before = Date.now();
      children[children.length - 1].emit("exit", 1, null);
      const status = sup.status();
      assert.equal(status.state, "failing", `exit ${i + 1} must leave the supervisor failing`);
      const delay = status.state === "failing" ? status.retryAt - before : -1;
      delays.push(delay);
      t.mock.timers.tick(delay);
    }

    assert.deepEqual(delays.slice(0, 3), [1000, 2000, 4000], "three quick exits in a row");
    assert.equal(delays[19], 60000, "the 20th exit's delay is the 60 s cap");
    assert.equal(children.length, 21, "1 initial spawn plus 20 restarts — it never gives up");
  });

  it("resets the attempt count after 60 s of healthy running, so the next exit waits 1 s again", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");

    // Build up backoff with two quick failures (delays 1 s, then 2 s)...
    children[0].emit("exit", 1, null);
    t.mock.timers.tick(1000);
    children[1].emit("exit", 1, null);
    const midway = sup.status();
    assert.equal(midway.state, "failing");
    if (midway.state === "failing") assert.equal(midway.retryAt - Date.now(), 2000);
    t.mock.timers.tick(2000);

    // ...then let the third child run healthy for a full 60 s before it exits.
    t.mock.timers.tick(60_000);
    children[2].emit("exit", 1, null);
    const after = sup.status();
    assert.equal(after.state, "failing");
    if (after.state === "failing") {
      assert.equal(
        after.retryAt - Date.now(),
        1000,
        "60 s of healthy running must reset the attempt count back to 0",
      );
    }
  });

  it("stop() sends SIGTERM, escalates to SIGKILL after 5 s with no exit, and schedules no restart", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");

    const stopped = sup.stop();
    assert.deepEqual(children[0].killCalls, ["SIGTERM"]);

    t.mock.timers.tick(5000);
    assert.deepEqual(children[0].killCalls, ["SIGTERM", "SIGKILL"], "no exit within 5 s escalates");

    // The real OS would have killed it by now; the fake child says so itself.
    children[0].emit("exit", null, "SIGKILL");
    await stopped;

    assert.deepEqual(sup.status(), { state: "off" } satisfies SupervisorStatus);
    t.mock.timers.tick(120_000);
    assert.equal(children.length, 1, "stop() must schedule no restart, however long we wait afterward");
  });

  it("stop() resolves immediately, with no kill, when nothing is running (a mid-backoff wait)", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");
    children[0].emit("exit", 1, null); // now mid-backoff, no live child

    await sup.stop();
    assert.deepEqual(sup.status(), { state: "off" } satisfies SupervisorStatus);
    t.mock.timers.tick(120_000);
    assert.equal(children.length, 1, "the pending restart must have been cancelled");
  });

  it("emits a 'line' event for every stdout and stderr line — readline over both", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    const lines: string[] = [];
    sup.on("line", (text: string) => lines.push(text));

    await sup.start("mediamtx", "config.yml");
    children[0].stdout.write("from stdout, one\nfrom stdout, two\n");
    children[0].stderr.write("from stderr\n");
    await settle();

    assert.deepEqual(
      [...lines].sort(),
      ["from stderr", "from stdout, one", "from stdout, two"],
      "stdout and stderr must both reach 'line', in whatever order they actually arrived",
    );
  });

  it("SIGTERMs a relay left running from the last run, named in relay.pid, before spawning its own", async (t) => {
    enableClock(t);
    await fs.mkdir(relayDir(), { recursive: true });
    await fs.writeFile(path.join(relayDir(), "relay.pid"), "4242", "utf8");

    const { spawnImpl, children } = fakeSpawn();
    const killed: Array<[number, NodeJS.Signals]> = [];
    const sup = new RelaySupervisor({
      spawnImpl,
      psImpl: async (pid) => (pid === 4242 ? "/opt/mediamtx/mediamtx /opt/mediamtx/mediamtx.yml" : null),
      killPid: (pid, signal) => killed.push([pid, signal]),
    });

    await sup.start("/opt/mediamtx/mediamtx", "config.yml");

    assert.deepEqual(killed, [[4242, "SIGTERM"]]);
    assert.equal(children.length, 1, "still spawns its own child after cleaning up the leftover");
  });

  it("does not SIGTERM a relay.pid pid whose command names a different binary", async (t) => {
    enableClock(t);
    await fs.mkdir(relayDir(), { recursive: true });
    await fs.writeFile(path.join(relayDir(), "relay.pid"), "4242", "utf8");

    const { spawnImpl } = fakeSpawn();
    const killed: Array<[number, NodeJS.Signals]> = [];
    const sup = new RelaySupervisor({
      spawnImpl,
      psImpl: async () => "/usr/bin/something-unrelated",
      killPid: (pid, signal) => killed.push([pid, signal]),
    });

    await sup.start("/opt/mediamtx/mediamtx", "config.yml");
    assert.deepEqual(killed, []);
  });

  it("logs a recovery once a failing run has held healthy for 60 s", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    const logSpy = t.mock.method(console, "log");

    await sup.start("mediamtx", "config.yml");
    children[0].stderr.write("ERR: boom\n");
    await settle();
    children[0].emit("exit", 1, null);
    t.mock.timers.tick(1000); // respawn
    t.mock.timers.tick(60_000); // the healthy mark

    const recovered = logSpy.mock.calls
      .map((call) => call.arguments[0] as string)
      .filter((line) => line.startsWith("[video] relay recovered"));
    assert.equal(recovered.length, 1, `expected one recovery line, got: ${JSON.stringify(recovered)}`);
    assert.match(recovered[0], /after 1 failed attempt/);
  });
});
