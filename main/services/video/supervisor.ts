// main/services/video/supervisor.ts — running MediaMTX as a child of this
// process, and never giving up on it.
//
// One RelaySupervisor per server. start() spawns the relay binary, reads its
// stdout and stderr line by line, and — on any exit that is not a stop() —
// schedules another spawn with backoff from 1 s to 60 s. There is no ceiling
// on retries: a misconfigured relay stays in `failing`, forever retried,
// rather than ever going quiet. Turning `status()` into the page's relay
// state lives in video-service.ts; reconciling paths once the relay's own
// API answers lives in mediamtx-relay.ts and reconcile-plan.ts, called by
// the service once the relay does.

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { errorMessage } from "../errors.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import { cleared } from "../timers.js";
import { relayDir } from "./acquire.js";
import { RelayLogWatcher } from "./relay-log.js";

const execFileAsync = promisify(execFile);

/** 1 s, doubling on every consecutive failure, capped at 60 s. There is no
 *  attempt past which this returns something larger — the cap IS the "never
 *  gives up" behavior; a spawn always follows, just no sooner than a minute
 *  apart. */
export function restartDelayMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** attempt);
}

/** How long a child must run, uninterrupted, before it counts as healthy
 *  again: the attempt count resets to 0 and, if this closes out a failing
 *  run, a recovery is logged. */
const HEALTHY_AFTER_MS = 60_000;

/** How long stop() waits for a graceful SIGTERM before escalating to
 *  SIGKILL. */
const STOP_KILL_AFTER_MS = 5_000;

const PID_FILE_NAME = "relay.pid";

type PidfileOp = "read" | "write" | "remove";
const PIDFILE_DONE: Record<PidfileOp, string> = { read: "read", write: "written", remove: "removed" };

/** How long a leftover relay has to exit after SIGTERM before SIGKILL, and
 *  how often it is looked for meanwhile. */
const LEFTOVER_EXIT_WAIT_MS = 5_000;
const LEFTOVER_POLL_MS = 100;

/** What a check for a relay left over from the last run found. */
export type LeftoverResult =
  | { kind: "none" }
  | { kind: "stopped"; pid: number }
  | { kind: "would-not-stop"; pid: number; error: string };

export type SupervisorStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "running"; since: number }
  /** `neverStarted`: true only for a genuine spawn failure (node's own
   *  spawn() never created a process at all — ENOENT, EACCES) — the ONE
   *  case nothing could have received a source, so its feeds read
   *  "standby"; false for a real child that ran and exited, which
   *  video-service.ts's own kind mapping reads as "offline" instead. */
  | { state: "failing"; reason: string; retryAt: number; neverStarted: boolean };

/**
 * The slice of `child_process.spawn`'s return value the supervisor actually
 * uses. Deliberately narrow, rather than the real `ChildProcessByStdio`
 * type: a test's fake child only has to implement these four members plus
 * EventEmitter, not the dozens of fields a real ChildProcess carries. A real
 * spawned child satisfies this structurally with no cast.
 */
export interface SupervisedChild extends EventEmitter {
  readonly pid?: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnImpl = (binary: string, args: string[]) => SupervisedChild;

/**
 * A running pid's command line, or null if it is not running (or `ps` is
 * unavailable). The real implementation shells out; every test injects a
 * fake so the suite never depends on, or signals, a real host process.
 */
export type PsLookup = (pid: number) => Promise<string | null>;

async function realPsLookup(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    // No such pid, or `ps` itself is unavailable — either way there is
    // nothing running to report, which is the caller's "do nothing" case.
    return null;
  }
}

function realSpawn(binary: string, args: string[]): SupervisedChild {
  return nodeSpawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Whether a `process.kill()` failure is the expected "already gone" case
 * (ESRCH — quiet; SIGTERM was going to reach that outcome anyway) rather
 * than something an operator needs to know about (EPERM, most commonly —
 * the leftover is still there and still holding the relay's ports).
 *
 * Split out from the default killPid below so the decision itself — the
 * part with a bug to have — is unit-testable on a synthetic error, without
 * ever calling the real `process.kill()`: there is no host pid safe to
 * signal on purpose to prove the non-ESRCH branch (pid 1 exists on every
 * host, but is not safe to touch even to have it refuse — a container's own
 * init can be pid 1 and does not universally refuse a signal the way a
 * bare host's does).
 */
export function isExpectedKillFailure(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ESRCH";
}

export interface RelaySupervisorOptions {
  spawnImpl?: SpawnImpl;
  psImpl?: PsLookup;
  /** Test seam for the leftover-pid kill, so a test never signals a real
   *  host pid. Real default is `process.kill`, swallowing ESRCH (the
   *  process is already gone, which is what SIGTERM was going to achieve)
   *  and rethrowing anything else — stopLeftover() is the caller, and
   *  decides what an operator is told. */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Every supervisor that currently has a live child, so the ONE process-level
 * "exit" listener below (registered once, module scope) can kill each of
 * them best-effort. Previously each RelaySupervisor registered its OWN
 * `process.once("exit", …)` in its constructor — never removed, since a
 * `once` listener only detaches once it FIRES, which for "exit" is once per
 * process lifetime. A long-running server restarting the relay (a crash
 * loop, a ports change) built one of these, and kept the whole discarded
 * supervisor alive through the closure, on every single restart: about ten
 * trip Node's own MaxListenersExceededWarning, and none of the earlier
 * instances were ever eligible for garbage collection.
 */
const liveSupervisors = new Set<RelaySupervisor>();
let exitHandlerRegistered = false;

function ensureExitHandlerRegistered(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.once("exit", () => {
    for (const supervisor of liveSupervisors) supervisor.killChildOnProcessExit();
  });
}

/**
 * Runs MediaMTX as a child of this process and restarts it forever, with
 * backoff from 1 s to 60 s. It never gives up — `status()` says it is
 * failing and why, and the caller decides what an operator sees.
 */
export class RelaySupervisor extends EventEmitter {
  private readonly spawnImpl: SpawnImpl;
  private readonly psImpl: PsLookup;
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void;
  private readonly watcher = new RelayLogWatcher();
  // The window a success must hold before a run is declared over, per
  // OutageLog's own contract (see repeat-log.ts). Set to HEALTHY_AFTER_MS,
  // not something longer: `ok()` is called exactly once per run, from
  // armHealthyTimer() below, at which point at least HEALTHY_AFTER_MS +
  // the shortest possible backoff (1 s) has passed since the failure that
  // opened the run — 61 s is the smallest that gap can ever be. A settleMs
  // any larger than 60 s would miss that first, most common recovery; any
  // smaller (well under the 1-60 s restart cadence this logs on) would risk
  // a rapid crash loop reading its own next spawn as an instant recovery,
  // which armHealthyTimer's single deferred call already rules out.
  private readonly outage = new OutageLog(HEALTHY_AFTER_MS);
  /** The leftover check and relay.pid's own read, write and removal: calls
   *  made once per start, spawn or exit, not on a timer, so a success held
   *  for HEALTHY_AFTER_MS is not something they ever show. Here a success
   *  ends the run, with one recovery line; each operation is its own key, so
   *  a remove finding nothing to remove never closes a write that fails. */
  private readonly bookkeepingOutage = new OutageLog(0);

  private binary = "";
  private configPath = "";
  /** Rewrites the config before every respawn — see start(). */
  private beforeRespawn: (() => Promise<void>) | null = null;
  /** Bumped by every start() and stop(), so a respawn whose rewrite was
   *  still in flight when either happened never spawns for a run that is
   *  over. */
  private run = 0;
  private child: SupervisedChild | null = null;
  private attempt = 0;
  private stopping = false;
  private current: SupervisorStatus = { state: "off" };
  private restartTimer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private stopWaiters: Array<() => void> = [];

  constructor(opts: RelaySupervisorOptions = {}) {
    super();
    this.spawnImpl = opts.spawnImpl ?? realSpawn;
    this.psImpl = opts.psImpl ?? realPsLookup;
    this.killPid =
      opts.killPid ??
      ((pid, signal) => {
        try {
          process.kill(pid, signal);
        } catch (err) {
          if (isExpectedKillFailure(err)) return;
          // stopLeftover() below is the only caller, and decides what to
          // tell the operator.
          throw err;
        }
      });
    // So the server never leaves a relay running after IT exits — whatever
    // child is current at that moment gets one signal, best effort (the
    // process is on its way out; there is nobody left to hand a failure to).
    // The listener itself is module-level and shared (see liveSupervisors'
    // own comment); this constructor only ensures it exists.
    ensureExitHandlerRegistered();
  }

  /** Called only from the shared module-level "exit" listener above. */
  killChildOnProcessExit(): void {
    this.child?.kill();
  }

  status(): SupervisorStatus {
    return this.current;
  }

  /** Sets `this.current` and tells anyone listening — emitted AFTER the
   *  change, so a "status" listener reading status() from inside its own
   *  handler sees the new value, never the one it is replacing. The single
   *  place every status transition (off, starting, running, failing) goes
   *  through, so nothing can update `this.current` without also emitting. */
  private setStatus(status: SupervisorStatus): void {
    this.current = status;
    this.emit("status", status);
  }

  /** The relay's own version string, parsed from its startup log line
   *  (`INF MediaMTX v1.21.1, ...`) — null until it has printed one.
   *  Survives a restart: the watcher is never replaced, only fed more
   *  lines, so the last version logged stays visible while a new child is
   *  starting up and has not logged its own yet. */
  version(): string | null {
    return this.watcher.version();
  }

  /**
   * A no-op unless the relay is currently off. Without this guard, a second
   * start() on an already-running relay would re-run stopLeftover() — which
   * reads relay.pid, finds the CURRENT child's own pid (this run already
   * wrote it) matching this same binary, and SIGTERMs its own healthy
   * child as if it were left over from a previous run — then spawn a
   * second child on top of it. Confirmed by forcing exactly this sequence:
   * `killed via stopLeftover during 2nd start(): [[1000,'SIGTERM']], children
   * spawned total: 2`. Call stop() first to restart with a clean state.
   *
   * The check and the "starting" state it sets both happen before the
   * first `await`, so two start() calls issued back to back (neither
   * awaited) cannot both pass it — the second always sees "starting", not
   * "off".
   *
   * A throw from either step (an injected psImpl that rejects, a spawnImpl
   * that throws) resets state back to "off" rather than leaving it wedged
   * in "starting" forever — the guard above would otherwise admit no
   * future start() at all, since "starting" is not "off". Rethrown, not
   * swallowed: the caller asked this relay to start and gets to know it
   * didn't.
   */
  async start(binary: string, configPath: string, beforeRespawn?: () => Promise<void>): Promise<void> {
    if (this.current.state !== "off") return;
    this.binary = binary;
    this.configPath = configPath;
    this.beforeRespawn = beforeRespawn ?? null;
    this.run++;
    this.stopping = false;
    this.attempt = 0;
    this.setStatus({ state: "starting" });
    try {
      const leftover = await this.stopLeftover(binary);
      if (leftover.kind === "would-not-stop") {
        const result = this.bookkeepingOutage.fail("relay-leftover-kill", leftover.error, Date.now());
        if (result.log) {
          console.warn(
            `[video] a relay left over from the last run (pid ${leftover.pid}) would not stop: ` +
              `${leftover.error}${result.note} — it may still be holding the relay's ports`,
          );
        }
      } else {
        const result = this.bookkeepingOutage.ok("relay-leftover-kill", Date.now());
        if (result.log) console.log(`[video] the relay left over from the last run is gone${result.note}`);
      }
      // A stop() that raced ahead of stopLeftover()'s await already cleared
      // stopWaiters and set state "off"; honor it rather than spawning anyway.
      if (this.stopping) return;
      this.spawnChild();
    } catch (err) {
      this.setStatus({ state: "off" });
      throw err;
    }
  }

  /** SIGTERM, then SIGKILL after STOP_KILL_AFTER_MS if the child has not
   *  exited, and no restart is scheduled either way — for a relay that was
   *  mid-backoff wait with no live child, this resolves immediately. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.run++;
    this.restartTimer = cleared(this.restartTimer);
    if (!this.child) {
      this.setStatus({ state: "off" });
      return;
    }
    const child = this.child;
    const done = new Promise<void>((resolve) => this.stopWaiters.push(resolve));
    child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, STOP_KILL_AFTER_MS);
    await done;
  }

  /**
   * If `relay.pid` names a still-live process running `binary`, stop it: the
   * previous run of this server never cleaned up after itself (the server
   * killed with SIGKILL, a crash, a power loss), and its relay still holds
   * every relay port. SIGTERM, then SIGKILL if it is still there after
   * LEFTOVER_EXIT_WAIT_MS; resolves once it has gone, so a port check made
   * after this sees the ports free. Public so relay-lifecycle.ts can run it
   * before its own port check; start() runs it too, for any other caller.
   * The caller decides what to tell an operator about one that would not
   * stop. Skipped on Windows, which has no `ps`.
   */
  async stopLeftover(binary: string): Promise<LeftoverResult> {
    if (process.platform === "win32") return { kind: "none" };
    let text: string;
    try {
      text = await fsp.readFile(path.join(relayDir(), PID_FILE_NAME), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.pidfileWorks("read"); // No pid file — nothing left over.
        return { kind: "none" };
      }
      this.reportPidfileTrouble("read", err);
      return { kind: "none" };
    }
    this.pidfileWorks("read");
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) return { kind: "none" };
    const running = async () => (await this.psImpl(pid))?.includes(binary) === true;
    if (!(await running())) return { kind: "none" };
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try {
        this.killPid(pid, signal);
      } catch (err) {
        return { kind: "would-not-stop", pid, error: errorMessage(err) };
      }
      for (let waited = 0; waited < LEFTOVER_EXIT_WAIT_MS; waited += LEFTOVER_POLL_MS) {
        if (!(await running())) {
          console.log(`[video] stopped a relay left over from the last run (pid ${pid})`);
          return { kind: "stopped", pid };
        }
        await new Promise((resolve) => setTimeout(resolve, LEFTOVER_POLL_MS));
      }
    }
    return { kind: "would-not-stop", pid, error: "still running after SIGTERM and SIGKILL" };
  }

  /** `relay.pid` itself could not be written, read or removed — every case
   *  has some real cause (disk full, permissions) and none is expected, so
   *  every one is worth a line: once per outage of that operation, and once
   *  more when it works again (pidfileWorks). */
  private reportPidfileTrouble(op: PidfileOp, err: unknown): void {
    const result = this.bookkeepingOutage.fail(`relay-pidfile-${op}`, errorMessage(err), Date.now());
    if (result.log) console.warn(`[video] could not ${op} relay.pid: ${errorMessage(err)}${result.note}`);
  }

  private pidfileWorks(op: PidfileOp): void {
    const result = this.bookkeepingOutage.ok(`relay-pidfile-${op}`, Date.now());
    if (result.log) console.log(`[video] relay.pid can be ${PIDFILE_DONE[op]} again${result.note}`);
  }

  private writePidFile(pid: number | undefined): void {
    if (pid === undefined) return;
    try {
      fs.mkdirSync(relayDir(), { recursive: true });
      fs.writeFileSync(path.join(relayDir(), PID_FILE_NAME), String(pid), "utf8");
    } catch (err) {
      // Bookkeeping for the NEXT run's leftover check, not THIS run — a
      // failure here changes nothing about the child already spawned, so it
      // is reported rather than returned (nobody is waiting on this call).
      this.reportPidfileTrouble("write", err);
      return;
    }
    this.pidfileWorks("write");
  }

  private deletePidFile(): void {
    try {
      fs.unlinkSync(path.join(relayDir(), PID_FILE_NAME));
    } catch (err) {
      // ENOENT: already gone (we may have raced a manual cleanup, or never
      // finished writing it) — nothing stale is left, so it counts as
      // working. Anything else leaves a stale pid file that will misfire
      // stopLeftover()'s command check on the next run.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.reportPidfileTrouble("remove", err);
        return;
      }
    }
    this.pidfileWorks("remove");
  }

  private spawnChild(): void {
    this.watcher.newProcess();
    const child = this.spawnImpl(this.binary, [this.configPath]);
    this.child = child;
    liveSupervisors.add(this);
    this.writePidFile(child.pid);
    this.setStatus({ state: "running", since: Date.now() });
    this.emit("spawned");
    this.attachReader(child.stdout);
    this.attachReader(child.stderr);
    // A bad binary path (ENOENT — the pinned
    // release moved or was never extracted) or one that is not executable
    // (EACCES) never reaches 'exit' at all — node_spawn() itself failed,
    // and reports it ONLY through 'error'. An EventEmitter with no 'error'
    // listener THROWS on that event by Node's own special case, crashing
    // this entire server over one bad path. 'exit' may still fire
    // afterward (code null, signal null, per Node's docs); handledBySpawnError
    // skips it so the same failure is not reported, and restarted, twice.
    let handledBySpawnError = false;
    // `on`, not `once`: a kill can fail more than once (stop() escalating
    // SIGTERM to SIGKILL), and an 'error' with no listener left throws,
    // taking the server down with it.
    child.on("error", (err: Error) => {
      if (this.child !== child) return;
      // 'error' is not ALWAYS a spawn
      // failure — a failed kill() (EPERM, say) fires it on an ALREADY-
      // RUNNING child too. `child.pid` is undefined ONLY when node's own
      // spawn() never actually created a process; that is the one case
      // this is a spawn failure at all.
      if (child.pid === undefined) {
        handledBySpawnError = true;
        this.onExit(null, `could not start: ${errorMessage(err)}`);
        return;
      }
      console.warn(`[video] the relay's own process reported an error: ${scrub(errorMessage(err))}`);
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      // A second, independent layer beyond start()'s re-entrancy guard: if
      // `this.child` has moved on to a newer child by the time THIS child
      // (closed over here, not read off `this` again) finally exits, that
      // exit is stale and must not touch the newer child's timers, pid
      // file or status.
      if (this.child !== child) return;
      if (handledBySpawnError) return;
      this.onExit(code, undefined, signal ?? null);
    });
    this.armHealthyTimer();
  }

  private attachReader(stream: Readable): void {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (text: string) => {
      this.watcher.line(text);
      this.emit("line", text);
    });
  }

  private armHealthyTimer(): void {
    this.healthyTimer = setTimeout(() => {
      this.attempt = 0;
      const result = this.outage.ok("relay", Date.now());
      if (result.log) console.log(`[video] relay recovered${result.note}`);
    }, HEALTHY_AFTER_MS);
  }

  /**
   * `setStatus()` assigns `this.current` before it emits "status", so any
   * listener reading `status()` from inside its own handler always sees the
   * value it was just told about, never the one it is replacing. "exit" is
   * emitted after "status" for the same reason, one step further out: a
   * listener reacting to "exit" (kept for existing callers) can trust
   * `status()` already reflects where this process landed, not whatever it
   * was on its way out.
   */
  private onExit(code: number | null, spawnError?: string, signal: NodeJS.Signals | null = null): void {
    this.healthyTimer = cleared(this.healthyTimer);
    this.killTimer = cleared(this.killTimer);
    this.child = null;
    liveSupervisors.delete(this);
    this.deletePidFile();
    const lastError = spawnError ?? this.watcher.lastError();

    if (this.stopping) {
      this.setStatus({ state: "off" });
      this.emit("exit", code, lastError);
      const waiters = this.stopWaiters;
      this.stopWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }

    // "killed by SIGKILL" or "exited with code 1": a signal kill has no
    // code, and "code null" said nothing.
    const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
    const reason = lastError ?? how;
    const delay = restartDelayMs(this.attempt);
    this.attempt += 1;
    this.setStatus({ state: "failing", reason, retryAt: Date.now() + delay, neverStarted: spawnError !== undefined });
    this.emit("exit", code, lastError);

    const result = this.outage.fail("relay", reason, Date.now());
    if (result.log) {
      const what = spawnError ? spawnError : lastError ? `${how}: ${lastError}` : how;
      console.warn(`[video] relay ${what}; restarting in ${delay / 1000} s${result.note}`);
    }
    this.restartTimer = setTimeout(() => void this.respawn(), delay);
  }

  /**
   * The next attempt after an exit. The config is rewritten first when
   * start() was handed a way to: the file on disk is whatever the last start
   * wrote, and a push feed's password rotated since then lives only in the
   * relay's memory, which the exit just lost. A rewrite that fails is a
   * failed attempt like a spawn that fails: failing with why, and retried.
   */
  private async respawn(): Promise<void> {
    this.restartTimer = null;
    const rewrite = this.beforeRespawn;
    if (!rewrite) {
      this.spawnChild();
      return;
    }
    const run = this.run;
    try {
      await rewrite();
    } catch (err) {
      if (run === this.run) this.onExit(null, `could not rewrite its config: ${errorMessage(err)}`);
      return;
    }
    if (run === this.run) this.spawnChild();
  }
}
