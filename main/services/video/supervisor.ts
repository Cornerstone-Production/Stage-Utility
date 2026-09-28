// main/services/video/supervisor.ts — running MediaMTX as a child of this
// process, and never giving up on it.
//
// One RelaySupervisor per server. start() spawns the relay binary, reads its
// stdout and stderr line by line, and — on any exit that is not a stop() —
// schedules another spawn with backoff from 1 s to 60 s. There is no ceiling
// on retries: a misconfigured relay stays in `failing`, forever retried,
// rather than ever going quiet. task 15 owns turning `status()` into the
// page's relay state, and reconciling paths once the relay's own API answers
// (task 11).

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { OutageLog } from "../repeat-log.js";
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

export type SupervisorStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "running"; since: number }
  | { state: "failing"; reason: string; retryAt: number };

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

export interface RelaySupervisorOptions {
  spawnImpl?: SpawnImpl;
  psImpl?: PsLookup;
  /** Test seam for the leftover-pid kill, so a test never signals a real
   *  host pid. Real default is `process.kill`, swallowing ESRCH — the
   *  process is already gone, which is what SIGTERM was going to achieve. */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
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

  private binary = "";
  private configPath = "";
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
        } catch {
          // Already gone — the outcome SIGTERM was going to reach anyway.
        }
      });
    // So the server never leaves a relay running after IT exits — whatever
    // child is current at that moment gets one signal, best effort (the
    // process is on its way out; there is nobody left to hand a failure to).
    process.once("exit", () => {
      this.child?.kill();
    });
  }

  status(): SupervisorStatus {
    return this.current;
  }

  async start(binary: string, configPath: string): Promise<void> {
    this.binary = binary;
    this.configPath = configPath;
    this.stopping = false;
    this.attempt = 0;
    this.current = { state: "starting" };
    await this.killLeftover();
    // A stop() that raced ahead of killLeftover()'s await already cleared
    // stopWaiters and set state "off"; honor it rather than spawning anyway.
    if (this.stopping) return;
    this.spawnChild();
  }

  /** SIGTERM, then SIGKILL after STOP_KILL_AFTER_MS if the child has not
   *  exited, and no restart is scheduled either way — for a relay that was
   *  mid-backoff wait with no live child, this resolves immediately. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    if (!this.child) {
      this.current = { state: "off" };
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

  /** If `relay.pid` names a still-live process running this same binary,
   *  SIGTERM it — the previous run of this server never got to clean up
   *  after itself (a crash, a kill -9, a power loss). Skipped on Windows,
   *  which has no `ps`. */
  private async killLeftover(): Promise<void> {
    if (process.platform === "win32") return;
    let text: string;
    try {
      text = await fsp.readFile(path.join(relayDir(), PID_FILE_NAME), "utf8");
    } catch {
      return; // No pid file — nothing left over.
    }
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) return;
    const cmd = await this.psImpl(pid);
    if (!cmd || !cmd.includes(this.binary)) return;
    this.killPid(pid, "SIGTERM");
    console.log(`[video] stopped a relay left over from the last run (pid ${pid})`);
  }

  private writePidFile(pid: number | undefined): void {
    if (pid === undefined) return;
    try {
      fs.mkdirSync(relayDir(), { recursive: true });
      fs.writeFileSync(path.join(relayDir(), PID_FILE_NAME), String(pid), "utf8");
    } catch {
      // Best-effort bookkeeping for the NEXT run's leftover check. A failure
      // here changes nothing about THIS run; it only means a future crash
      // would leave an orphan killLeftover() cannot find. Nothing to return
      // it to — start() has already committed to spawning.
    }
  }

  private deletePidFile(): void {
    try {
      fs.unlinkSync(path.join(relayDir(), PID_FILE_NAME));
    } catch {
      // Same reasoning as writePidFile: best-effort, and a stale file here
      // only fails killLeftover()'s command check on the next run rather
      // than misidentifying an unrelated process.
    }
  }

  private spawnChild(): void {
    const child = this.spawnImpl(this.binary, [this.configPath]);
    this.child = child;
    this.writePidFile(child.pid);
    this.current = { state: "running", since: Date.now() };
    this.emit("spawned");
    this.attachReader(child.stdout);
    this.attachReader(child.stderr);
    child.once("exit", (code: number | null) => this.onExit(code));
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

  private clearHealthyTimer(): void {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.healthyTimer = null;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearKillTimer(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
  }

  private onExit(code: number | null): void {
    this.clearHealthyTimer();
    this.clearKillTimer();
    this.child = null;
    this.deletePidFile();
    const lastError = this.watcher.lastError();
    this.emit("exit", code, lastError);

    if (this.stopping) {
      this.current = { state: "off" };
      const waiters = this.stopWaiters;
      this.stopWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }

    const reason = lastError ?? `exit code ${code}`;
    const delay = restartDelayMs(this.attempt);
    this.attempt += 1;
    this.current = { state: "failing", reason, retryAt: Date.now() + delay };

    const result = this.outage.fail("relay", reason, Date.now());
    if (result.log) {
      console.warn(`[video] relay exited (code ${code}): ${reason}; restarting in ${delay / 1000} s${result.note}`);
    }
    this.restartTimer = setTimeout(() => this.spawnChild(), delay);
  }
}
