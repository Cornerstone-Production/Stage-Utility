import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-supervisor-"));
process.env.STAGE_UTILITY_DATA = TMP;
// A generous cap for a file that builds many short-lived supervisors and
// fake children across its cases — the default is a heuristic tuned for a
// long-lived server process, not this. RelaySupervisor itself registers only
// ONE shared process "exit" listener no matter how many instances this suite
// builds (see supervisor.ts's own liveSupervisors comment).
process.setMaxListeners(50);

const { relayDir } = await import("./acquire.js");
const { RelaySupervisor, restartDelayMs, isExpectedKillFailure } = await import("./supervisor.js");
import type { PsLookup, SpawnImpl, SupervisorStatus } from "./supervisor.js";
import { captureConsole } from "../fixtures/capture-console.js";

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
  // number | undefined, matching the real SupervisedChild interface: node's
  // own child_process leaves pid undefined when spawn() never actually
  // created a process at all — the one shape the supervisor
  // reads as a genuine spawn failure, distinct from an 'error' on a child
  // that DID spawn (a failed kill(), say).
  pid: number | undefined;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: NodeJS.Signals | number): boolean;
  killCalls: Array<NodeJS.Signals | number | undefined>;
}

function makeFakeChild(pid: number | undefined): FakeChild {
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

/** Like fakeSpawn(), but the FIRST child has no pid at all — node's own
 *  shape for "spawn() never created a process", the genuine spawn-failure
 *  case. Every later spawn (a retry) gets a real one. */
function fakeSpawnFirstHasNoPid(): { spawnImpl: SpawnImpl; children: FakeChild[] } {
  const children: FakeChild[] = [];
  let nextPid = 1000;
  let first = true;
  const spawnImpl: SpawnImpl = () => {
    const child = makeFakeChild(first ? undefined : nextPid++);
    first = false;
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

describe("isExpectedKillFailure", () => {
  it("treats ESRCH as expected (already gone), and everything else as not", () => {
    assert.equal(isExpectedKillFailure(Object.assign(new Error("no such process"), { code: "ESRCH" })), true);
    assert.equal(isExpectedKillFailure(Object.assign(new Error("not permitted"), { code: "EPERM" })), false);
    assert.equal(isExpectedKillFailure(new Error("no code at all")), false);
    assert.equal(isExpectedKillFailure(null), false);
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
      neverStarted: false,
    } satisfies SupervisorStatus);

    t.mock.timers.tick(1000);
    assert.equal(children.length, 2, "the 1 s backoff must end in another spawn");
    assert.deepEqual(sup.status(), { state: "running", since: START + 1000 } satisfies SupervisorStatus);
  });

  it("a relay killed by a signal says which, and never \"code null\"", async (t) => {
    enableClock(t);
    const lines = captureConsole(t, "warn");
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");
    children[0]!.emit("exit", null, "SIGKILL");
    assert.deepEqual(sup.status(), {
      state: "failing",
      reason: "killed by SIGKILL",
      retryAt: START + 1000,
      neverStarted: false,
    } satisfies SupervisorStatus);
    assert.deepEqual(lines, ["[video] relay killed by SIGKILL; restarting in 1 s"]);
  });

  it("an exit reports its own process's last error, never an earlier process's", async (t) => {
    enableClock(t);
    const lines = captureConsole(t, "warn");
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");
    children[0]!.stderr.write('2026/09/28 12:00:00 ERR json: unknown field "rtsps"\n');
    await settle();
    children[0]!.emit("exit", 1, null);
    assert.equal((sup.status() as { reason: string }).reason, 'json: unknown field "rtsps"');

    t.mock.timers.tick(1000); // the respawn prints no error of its own
    children[1]!.emit("exit", 2, null);
    assert.equal((sup.status() as { reason: string }).reason, "exited with code 2", "the second process never printed that error");
    assert.equal(lines.at(-1)?.includes("rtsps"), false, `the second exit's line carried the first process's error: ${lines.at(-1)}`);
  });

  // A respawn must not start from whatever config the last start wrote: a
  // push password rotated since is in the relay's memory, not in that file.
  it("rewrites the config before every respawn, and only then spawns", async (t) => {
    enableClock(t);
    const order: string[] = [];
    const { spawnImpl: inner, children } = fakeSpawn();
    const spawnImpl: SpawnImpl = (binary, args) => {
      order.push("spawn");
      return inner(binary, args);
    };
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml", async () => {
      order.push("rewrite");
    });
    assert.deepEqual(order, ["spawn"], "the first spawn uses the config start() was handed");

    children[0]!.emit("exit", 1, null);
    t.mock.timers.tick(1000);
    await settle();
    assert.deepEqual(order, ["spawn", "rewrite", "spawn"]);
    assert.equal(sup.status().state, "running");
  });

  it("a config that cannot be rewritten is a failed attempt: failing with why, no child, and retried", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    let rewrites = 0;
    await sup.start("mediamtx", "config.yml", async () => {
      rewrites++;
      if (rewrites === 1) throw new Error("EACCES: permission denied");
    });
    children[0]!.emit("exit", 1, null);
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(children.length, 1, "no child may spawn from a config that was not rewritten");
    assert.deepEqual(sup.status(), {
      state: "failing",
      reason: "could not rewrite its config: EACCES: permission denied",
      retryAt: START + 1000 + 2000,
      neverStarted: true,
    } satisfies SupervisorStatus);

    t.mock.timers.tick(2000);
    await settle();
    assert.equal(children.length, 2, "the next attempt rewrites and spawns");
  });

  it("stop() while a respawn's rewrite is in flight spawns nothing", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let rewrites = 0;
    await sup.start("mediamtx", "config.yml", async () => {
      rewrites++;
      await held;
    });
    children[0]!.emit("exit", 1, null);
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(rewrites, 1);
    await sup.stop();
    release();
    await settle();
    assert.equal(children.length, 1, "a stopped supervisor spawned a child anyway");
    assert.equal(sup.status().state, "off");
  });

  // A bad binary path (ENOENT — the pinned
  // release moved or was never extracted) never reaches 'exit' at all —
  // node's own spawn() failed, and reports it ONLY through 'error'. An
  // EventEmitter with no 'error' listener THROWS on that event, which would
  // crash this entire server over one bad path.
  it("a spawn failure ('error' on a pid-less child, never 'exit') reports failing and still retries — an unlistened 'error' would otherwise crash the process", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawnFirstHasNoPid();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });

    await sup.start("mediamtx", "config.yml");
    assert.equal(children.length, 1);
    assert.equal(children[0]!.pid, undefined, "precondition: this child never actually spawned");

    children[0]!.emit("error", Object.assign(new Error("spawn mediamtx ENOENT"), { code: "ENOENT" }));
    assert.deepEqual(sup.status(), {
      state: "failing",
      reason: "could not start: spawn mediamtx ENOENT",
      retryAt: START + 1000,
      neverStarted: true,
    } satisfies SupervisorStatus);

    t.mock.timers.tick(1000);
    assert.equal(children.length, 2, "the 1 s backoff must end in another spawn attempt");
    assert.deepEqual(sup.status(), { state: "running", since: START + 1000 } satisfies SupervisorStatus);
  });

  it("a spawn failure's 'exit' (code null, per Node's own docs) is not reported a second time", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawnFirstHasNoPid();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");

    children[0]!.emit("error", Object.assign(new Error("spawn mediamtx ENOENT"), { code: "ENOENT" }));
    const afterError = sup.status();
    children[0]!.emit("exit", null, null);
    assert.deepEqual(sup.status(), afterError, "the trailing 'exit' changed status — the failure was counted twice");

    // If BOTH 'error' and 'exit' had each scheduled their own restart timer,
    // ticking past the single 1 s backoff once would fire both, spawning
    // TWO more children instead of one.
    t.mock.timers.tick(1000);
    assert.equal(children.length, 2, `expected exactly one restart, got ${children.length - 1}`);
  });

  // 'error' fires for reasons OTHER than a
  // spawn failure too — a failed kill() (EPERM, say) on a child that DID
  // spawn (a real pid). That must not be relabeled "could not start" —
  // the process is (or was) genuinely running.
  it("an 'error' on a child that DID spawn (a real pid — a failed kill(), say) is not read as a spawn failure", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");
    assert.notEqual(children[0]!.pid, undefined, "precondition: this child DID spawn");

    const warns = captureConsole(t, "warn");
    children[0]!.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));

    assert.deepEqual(
      sup.status(),
      { state: "running", since: START } satisfies SupervisorStatus,
      "an error on an already-running child must not flip status to failing",
    );
    assert.ok(
      warns.some((w) => w.includes("the relay's own process reported an error") && w.includes("kill EPERM")),
      `expected the error to be logged, got: ${JSON.stringify(warns)}`,
    );
  });

  // A kill that fails can fail again — stop() escalating SIGTERM to SIGKILL
  // against a process it may not signal. An EventEmitter with no 'error'
  // listener throws, which from a child process's event takes the whole
  // server down.
  it("a second 'error' on a running child is handled too, never thrown", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");
    const warns = captureConsole(t, "warn");
    const eperm = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    children[0]!.emit("error", eperm());
    assert.doesNotThrow(() => children[0]!.emit("error", eperm()), "a second error on the same child went unheard and threw");
    assert.equal(warns.filter((w) => w.includes("kill EPERM")).length, 2);
    assert.equal(sup.status().state, "running");
  });

  // A real v1.21.1 binary given a malformed pull source echoed the
  // WHOLE credentialed URL back in its own ERR line — this is what the
  // supervisor turns into both its exit reason (status.reason) and the
  // "relay exited" log line, so neither may carry it through.
  it("a credentialed ERR line never reaches the exit reason or the \"relay exited\" log line", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    await sup.start("mediamtx", "config.yml");

    const lines = captureConsole(t, "warn");

    children[0].stderr.write(
      "2026/09/28 12:00:00 ERR [API] 'rtsp://admin:s3c%!z(MISSING)ret@192.0.2.1/s' is not a valid URL\n",
    );
    await settle();

    children[0].emit("exit", 1, null);
    const status = sup.status();
    assert.equal(status.state, "failing");
    if (status.state !== "failing") throw new Error("unreachable");
    assert.equal(status.reason.includes("admin"), false, "the username must not survive into status.reason");
    assert.equal(status.reason.includes("s3c"), false, "no fragment of the password may survive into status.reason");

    const exitLine = lines.find((l) => l.includes("relay exited"));
    assert.ok(exitLine, "expected the \"relay exited\" log line");
    assert.equal(exitLine!.includes("admin"), false, "the username must not survive into the log line either");
    assert.equal(exitLine!.includes("s3c"), false, "no fragment of the password may survive into the log line either");
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

  it("emits 'status' after every transition, and 'exit' after 'status' — never the reverse", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    const seen: Array<{ event: string; statusAtEmitTime: SupervisorStatus["state"] }> = [];
    sup.on("status", (s: SupervisorStatus) => seen.push({ event: "status", statusAtEmitTime: s.state }));
    sup.on("exit", () => seen.push({ event: "exit", statusAtEmitTime: sup.status().state }));

    await sup.start("mediamtx", "config.yml");
    assert.deepEqual(
      seen,
      [{ event: "status", statusAtEmitTime: "starting" }, { event: "status", statusAtEmitTime: "running" }],
      "start() must emit status for both starting and running, never exit",
    );

    seen.length = 0;
    children[0].emit("exit", 1, null);
    assert.deepEqual(
      seen,
      [{ event: "status", statusAtEmitTime: "failing" }, { event: "exit", statusAtEmitTime: "failing" }],
      "status must fire before exit, and status() must already read the NEW state by the time exit's own listener runs",
    );

    seen.length = 0;
    t.mock.timers.tick(1000); // the respawn
    assert.deepEqual(seen, [{ event: "status", statusAtEmitTime: "running" }], "a respawn is a status event, not another exit");

    seen.length = 0;
    const stopped = sup.stop();
    children[1].emit("exit", null, "SIGTERM");
    await stopped;
    assert.deepEqual(
      seen,
      [{ event: "status", statusAtEmitTime: "off" }, { event: "exit", statusAtEmitTime: "off" }],
      "stop()'s own exit must also see status fire first",
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
      // Running until it is signalled, as a leftover that honours SIGTERM is.
      psImpl: async (pid) => (pid === 4242 && killed.length === 0 ? "/opt/mediamtx/mediamtx /opt/mediamtx/mediamtx.yml" : null),
      killPid: (pid, signal) => killed.push([pid, signal]),
    });

    await sup.start("/opt/mediamtx/mediamtx", "config.yml");

    assert.deepEqual(killed, [[4242, "SIGTERM"]]);
    assert.equal(children.length, 1, "still spawns its own child after cleaning up the leftover");
  });

  // Its ports are free only once it has actually gone, so a port check made
  // after this must not find the leftover still holding them.
  it("stopLeftover resolves only once the leftover has exited, and SIGKILLs one that ignores SIGTERM", async (t) => {
    enableClock(t);
    await fs.mkdir(relayDir(), { recursive: true });
    await fs.writeFile(path.join(relayDir(), "relay.pid"), "4242", "utf8");
    const killed: NodeJS.Signals[] = [];
    const sup = new RelaySupervisor({
      spawnImpl: fakeSpawn().spawnImpl,
      psImpl: async () => (killed.includes("SIGKILL") ? null : "/opt/mediamtx/mediamtx cfg.yml"),
      killPid: (_pid, signal) => killed.push(signal),
    });
    let result: unknown = null;
    void sup.stopLeftover("/opt/mediamtx/mediamtx").then((r) => (result = r));
    // relay.pid is read from the real disk, which under load takes more than
    // a turn or two; a tick before the first wait is armed would be lost.
    for (let i = 0; i < 10_000 && killed.length === 0; i++) await settle();
    assert.deepEqual(killed, ["SIGTERM"]);
    for (let i = 0; i < 49; i++) {
      await settle();
      t.mock.timers.tick(100);
    }
    await settle();
    assert.equal(result, null, "resolved while the leftover was still running");
    assert.deepEqual(killed, ["SIGTERM"]);
    for (let i = 0; i < 3; i++) {
      await settle();
      t.mock.timers.tick(100);
    }
    await settle();
    await settle();
    assert.deepEqual(killed, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(result, { kind: "stopped", pid: 4242 });
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

  it("version() returns the relay's own version once logged, and null before that", async (t) => {
    enableClock(t);
    const { spawnImpl, children } = fakeSpawn();
    const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
    assert.equal(sup.version(), null, "nothing logged yet");

    await sup.start("mediamtx", "config.yml");
    children[0].stdout.write("2026/09/28 12:00:00 INF MediaMTX v1.21.1, darwin, arm64\n");
    await settle();

    assert.equal(sup.version(), "v1.21.1");
  });

  it("a throw during start() (a rejecting psImpl) resets state to \"off\" rather than wedging in \"starting\"", async (t) => {
    enableClock(t);
    await fs.mkdir(relayDir(), { recursive: true });
    await fs.writeFile(path.join(relayDir(), "relay.pid"), "4242", "utf8");

    const { spawnImpl, children } = fakeSpawn();
    const boom = new Error("ps lookup failed");
    let shouldFail = true;
    const sup = new RelaySupervisor({
      spawnImpl,
      psImpl: async () => {
        if (shouldFail) throw boom;
        return null; // no leftover — proceeds straight to spawning
      },
    });

    await assert.rejects(() => sup.start("mediamtx", "config.yml"), boom);
    assert.deepEqual(sup.status(), { state: "off" } satisfies SupervisorStatus);
    assert.equal(children.length, 0, "the failed start() must not have spawned anything");

    // Without the fix, the guard added for a second start() (state !== "off")
    // would now refuse this forever, since a wedged "starting" never becomes
    // "off" again on its own.
    shouldFail = false;
    await sup.start("mediamtx", "config.yml");
    assert.equal(children.length, 1, "a later start(), once the failure clears, must actually spawn");
    assert.equal(sup.status().state, "running");
  });

  describe("a second start() without stop() first", () => {
    it("is a no-op while running — no leftover kill, no second child", async (t) => {
      enableClock(t);
      const { spawnImpl, children } = fakeSpawn();
      const killed: Array<[number, NodeJS.Signals]> = [];
      const sup = new RelaySupervisor({
        spawnImpl,
        // Would match relay.pid's content (this run's own child) if
        // killLeftover() were ever wrongly re-run by a second start().
        psImpl: async () => "mediamtx config.yml",
        killPid: (pid, signal) => killed.push([pid, signal]),
      });

      await sup.start("mediamtx", "config.yml");
      assert.equal(children.length, 1);
      const statusAfterFirst = sup.status();

      await sup.start("mediamtx", "config.yml");

      assert.equal(children.length, 1, "a second start() while running must not spawn another child");
      assert.deepEqual(killed, [], "a second start() must never SIGTERM its own healthy child as a leftover");
      assert.deepEqual(sup.status(), statusAfterFirst, "state must be untouched by the no-op start()");
    });

    it("is a no-op while failing (a pending backoff wait) — the scheduled restart is not reset", async (t) => {
      enableClock(t);
      const { spawnImpl, children } = fakeSpawn();
      const killed: Array<[number, NodeJS.Signals]> = [];
      const sup = new RelaySupervisor({
        spawnImpl,
        // Would match relay.pid's content if killLeftover() were ever
        // wrongly re-run by a second start() during the backoff wait.
        psImpl: async () => "mediamtx config.yml",
        killPid: (pid, signal) => killed.push([pid, signal]),
      });

      await sup.start("mediamtx", "config.yml");
      children[0].emit("exit", 1, null); // now failing, a 1 s backoff pending
      const statusWhileFailing = sup.status();
      assert.equal(statusWhileFailing.state, "failing");

      await sup.start("mediamtx", "config.yml");

      assert.equal(children.length, 1, "a second start() while failing must not spawn another child yet");
      assert.deepEqual(killed, [], "a second start() must never attempt a leftover kill while failing");
      assert.deepEqual(sup.status(), statusWhileFailing, "the pending backoff must be untouched, not reset");

      // The ORIGINAL scheduled restart must still fire on schedule — a
      // second start() must not have cancelled or rescheduled it.
      t.mock.timers.tick(1000);
      assert.equal(children.length, 2, "the original backoff timer must still fire");
    });

    it("is a no-op while starting — two calls issued back-to-back, neither awaited first, still spawn one child", async (t) => {
      enableClock(t);
      const { spawnImpl, children } = fakeSpawn();
      const killed: Array<[number, NodeJS.Signals]> = [];
      const sup = new RelaySupervisor({
        spawnImpl,
        psImpl: async () => "mediamtx config.yml",
        killPid: (pid, signal) => killed.push([pid, signal]),
      });

      // Neither is awaited before the other is called — both synchronous
      // prologues run before either's first `await` suspends it.
      const p1 = sup.start("mediamtx", "config.yml");
      const p2 = sup.start("mediamtx", "config.yml");
      await Promise.all([p1, p2]);

      assert.equal(children.length, 1, "only the call that first set state to \"starting\" may spawn");
      assert.deepEqual(killed, []);
    });

    it("a stale child's exit cannot change status or schedule a restart once a newer child has taken over", async (t) => {
      enableClock(t);
      const { spawnImpl, children } = fakeSpawn();
      const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
      await sup.start("mediamtx", "config.yml");
      const staleChild = children[0];
      const statusBefore = sup.status();

      // start()'s re-entrancy guard above already closes off every PUBLIC
      // path that could leave `this.child` pointing somewhere other than
      // the one child whose exit is still pending. This proves the exit
      // closure's own identity check as a second, independent layer of
      // defense, by reaching past the public API to force exactly the state
      // that once corrupted this (this.child reassigned to a newer child
      // while an older child, SIGTERMed by killLeftover, was still on its
      // way out).
      const decoy = makeFakeChild(999999);
      (sup as unknown as { child: FakeChild }).child = decoy;

      staleChild.emit("exit", 1, null);

      assert.deepEqual(sup.status(), statusBefore, "a stale child's exit must be a complete no-op");
      t.mock.timers.tick(120_000);
      assert.equal(children.length, 1, "no restart may be scheduled from a stale exit");
    });
  });

  describe("a leftover-pid failure is reported, never swallowed", () => {
    it("the default killPid quietly accepts a leftover pid that is already gone (ESRCH)", async (t) => {
      enableClock(t);
      await fs.mkdir(relayDir(), { recursive: true });
      // A pid guaranteed not to be running: spawnSync blocks until this
      // short-lived child has already exited, so signalling its pid throws
      // ESRCH — exactly the case the real, uninjected default killPid must
      // swallow.
      const finished = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      const goneP = finished.pid;
      assert.ok(typeof goneP === "number" && goneP > 0, "expected a real pid from the short-lived child");
      await fs.writeFile(path.join(relayDir(), "relay.pid"), String(goneP), "utf8");

      const { spawnImpl, children } = fakeSpawn();
      const warnSpy = t.mock.method(console, "warn");
      let signalled = false;
      const sup = new RelaySupervisor({
        spawnImpl,
        // "Running" once, for the check that finds it; gone after the kill
        // the real default made against a pid that no longer exists.
        psImpl: async (pid) => {
          if (pid !== goneP || signalled) return null;
          signalled = true;
          return "/opt/mediamtx/mediamtx config.yml";
        },
        // No killPid override — this exercises the real default.
      });

      await sup.start("/opt/mediamtx/mediamtx", "config.yml");

      assert.equal(children.length, 1, "still starts its own relay");
      assert.deepEqual(warnSpy.mock.calls, [], "ESRCH is the expected case and must stay quiet");
    });

    it("a non-ESRCH failure to kill a leftover is reported, not swallowed", async (t) => {
      enableClock(t);
      await fs.mkdir(relayDir(), { recursive: true });
      await fs.writeFile(path.join(relayDir(), "relay.pid"), "4242", "utf8");

      const { spawnImpl, children } = fakeSpawn();
      const warnSpy = t.mock.method(console, "warn");
      const sup = new RelaySupervisor({
        spawnImpl,
        psImpl: async () => "/opt/mediamtx/mediamtx config.yml",
        killPid: () => {
          const err = new Error("Operation not permitted") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        },
      });

      await sup.start("/opt/mediamtx/mediamtx", "config.yml");

      assert.equal(children.length, 1, "still starts its own relay despite the leftover it could not stop");
      const warned = warnSpy.mock.calls.map((c) => c.arguments[0] as string);
      assert.ok(
        warned.some((line) => line.includes("pid 4242") && line.includes("would not stop")),
        `expected a could-not-stop warning naming the leftover, got: ${JSON.stringify(warned)}`,
      );
    });

    it("a non-ENOENT failure to read relay.pid is reported, not swallowed", async (t) => {
      enableClock(t);
      // A DIRECTORY named relay.pid, not a file: reading it throws EISDIR, a
      // real, non-ENOENT error, with no need to fake the filesystem. The
      // same fixture also makes writePidFile's own write fail the same way
      // once start() gets to spawning its own child, so both lines are
      // asserted for.
      await fs.mkdir(path.join(relayDir(), "relay.pid"), { recursive: true });

      const { spawnImpl, children } = fakeSpawn();
      const warnSpy = t.mock.method(console, "warn");
      const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });

      await sup.start("mediamtx", "config.yml");

      assert.equal(children.length, 1, "still starts its own relay despite the pidfile trouble");
      const warned = warnSpy.mock.calls.map((c) => c.arguments[0] as string);
      assert.ok(
        warned.some((line) => line.startsWith("[video] could not read relay.pid:")),
        `expected a could-not-read warning, got: ${JSON.stringify(warned)}`,
      );
      assert.ok(
        warned.some((line) => line.startsWith("[video] could not write relay.pid:")),
        `expected a could-not-write warning too, got: ${JSON.stringify(warned)}`,
      );
    });
  });

  // A pidfile or leftover failure opens its own outage run: one line, quiet
  // on the same failure again, and one line once the operation works again,
  // so a later failure is news once more.
  describe("a pidfile or leftover outage closes on its next success", () => {
    it("a relay.pid that cannot be written logs once, stays quiet on a repeat, and logs when it can be written again", async (t) => {
      enableClock(t);
      // A DIRECTORY named relay.pid: every spawn's write fails with EISDIR.
      await fs.mkdir(path.join(relayDir(), "relay.pid"), { recursive: true });
      const lines = captureConsole(t, "warn", "log");
      const { spawnImpl, children } = fakeSpawn();
      const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
      const writeLines = () => lines.filter((l) => l.includes("write relay.pid") || l.includes("can be written again"));

      await sup.start("mediamtx", "config.yml");
      assert.equal(writeLines().length, 1, JSON.stringify(lines));
      assert.match(writeLines()[0]!, /^\[video\] could not write relay\.pid: EISDIR/);

      children[0]!.emit("exit", 1, null); // a crash; the respawn writes again
      t.mock.timers.tick(1000);
      assert.equal(children.length, 2);
      assert.equal(writeLines().length, 1, "the same failure again, inside the same run, must stay quiet");

      await fs.rm(path.join(relayDir(), "relay.pid"), { recursive: true, force: true });
      children[1]!.emit("exit", 1, null);
      t.mock.timers.tick(2000);
      assert.equal(children.length, 3);
      assert.deepEqual(writeLines().slice(1), ["[video] relay.pid can be written again after 2 failed attempts (under a minute)"]);
    });

    it("a leftover that would not stop logs once, stays quiet on a repeat, and logs once it is gone", async (t) => {
      enableClock(t);
      await fs.mkdir(relayDir(), { recursive: true });
      const lines = captureConsole(t, "warn", "log");
      const { spawnImpl, children } = fakeSpawn();
      let leftoverRunning = true;
      const sup = new RelaySupervisor({
        spawnImpl,
        psImpl: async (pid) => (pid === 4242 && leftoverRunning ? "/opt/mediamtx/mediamtx config.yml" : null),
        killPid: () => {
          const err = new Error("Operation not permitted") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        },
      });
      const leftoverLines = () => lines.filter((l) => l.includes("left over from the last run"));
      // The leftover's pid goes back into relay.pid before every start: each
      // start's own child writes its own there, and removes it on exit.
      const startWithLeftover = async () => {
        await fs.writeFile(path.join(relayDir(), "relay.pid"), "4242", "utf8");
        await sup.start("/opt/mediamtx/mediamtx", "config.yml");
      };
      const stop = async () => {
        const stopped = sup.stop();
        children.at(-1)!.emit("exit", 0, null);
        await stopped;
      };

      await startWithLeftover();
      await stop();
      await startWithLeftover();
      assert.equal(leftoverLines().length, 1, `the same failure again must stay quiet: ${JSON.stringify(leftoverLines())}`);
      assert.match(leftoverLines()[0]!, /pid 4242\) would not stop: Operation not permitted/);

      await stop();
      leftoverRunning = false;
      await startWithLeftover();
      assert.deepEqual(leftoverLines().slice(1), [
        "[video] the relay left over from the last run is gone after 2 failed attempts (under a minute)",
      ]);
      assert.equal(children.length, 3, "every start still spawned its own relay");
    });
  });

  describe("the process-level exit listener", () => {
    it("stays at one no matter how many supervisors this process builds and stops", async (t) => {
      enableClock(t);
      const before = process.listenerCount("exit");
      for (let i = 0; i < 12; i++) {
        const { spawnImpl, children } = fakeSpawn();
        const sup = new RelaySupervisor({ spawnImpl, psImpl: neverLeftover });
        await sup.start("mediamtx", "config.yml");
        const stopped = sup.stop();
        children[0]!.emit("exit", 0, null);
        await stopped;
      }
      assert.equal(
        process.listenerCount("exit"),
        before,
        "each RelaySupervisor must share ONE process-level exit listener, not register its own",
      );
    });
  });
});
