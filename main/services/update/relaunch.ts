// relaunch.ts — bringing THIS server back after a deliberate self-restart.
//
// Everywhere else, "restart" means exit(0) and let the service manager relaunch
// us: systemd has Restart=always, Task Scheduler has RestartCount. On launchd
// that contract is broken: launchd PARKS nondemand spawns for background jobs —
// `launchctl print` shows "pended nondemand spawn = inefficient" (a KeepAlive
// respawn) or "= speculative" (a RunAtLoad start) with the job simply never
// running. Observed live on a Homebrew install, 2026-08-13: a config restore
// exited cleanly, KeepAlive queued the respawn, launchd tagged it inefficient,
// and the box stayed dark until a human ran kickstart.
//
// The one thing launchd never parks is a DEMAND spawn — `launchctl kickstart`.
// So on macOS, every deliberate self-restart also spawns a detached helper that
// kickstarts our own label after the exit. If the helper fails, the worst case
// is exactly today's behavior; when it works, the box comes back by itself.

import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";

import { APP_ROOT } from "../app-root.js";
import { detectInstallKind, type InstallKind } from "./install-kind.js";
import { FORMULA, kickstartLabel, serviceLabel } from "./homebrew-strategy.js";
import { launchctlProbe, resolveDaemonLabel, type DaemonLabel, type LabelProbe } from "./launchd-label.js";
import type { SpawnPlan } from "./strategy.js";

/** The kick for one launchd job: what to spawn, and which job that is. */
interface Kick {
  plan: SpawnPlan;
  job: string;
}

/**
 * Decide what to kick for this install, or null where the service manager
 * already relaunches reliably (everything that is not launchd, and an install
 * that is not one of ours).
 *
 * The command itself is kickstartLabel — the same one the Homebrew update path
 * uses, for the same reasons (see its doc for why `-k -p`, and why it tries gui
 * before system and never fails). The sleep puts the kickstart safely after our
 * own exit; if we are already gone, -k is a no-op.
 */
function kickFor(
  kind: InstallKind,
  appRoot: string,
  platform: NodeJS.Platform,
  tarballLabel: DaemonLabel | null,
): Kick | null {
  if (platform !== "darwin") return null;

  // A DISCRIMINANT, not a string built from appRoot.
  //
  // The label has always been one of a few module constants -- launchdKind only
  // ever used appRoot for `.includes()` checks and never put it in the result --
  // but "the value is constant" was three functions away from where it mattered.
  // Returning which-one and picking the literal here means the string that lands
  // in a `bash -c` command is written in this file, at the point it is used.
  //
  // That is worth having on its own, and it is also what static analysis needs.
  // appRoot comes from STAGE_UTILITY_ROOT, so CodeQL followed an environment
  // value into a shell string and reported it at medium -- correctly, given what
  // it could see. Types do not help: they are erased before it looks. Only the
  // dataflow does. The same goes for tarballLabel, which resolveDaemonLabel
  // picks FROM the constants rather than copying out of XPC_SERVICE_NAME.
  let job: string | null;
  switch (launchdKind(kind, appRoot)) {
    case "tarball":
      job = tarballLabel;
      break;
    case "beta":
      job = serviceLabel(FORMULA.beta);
      break;
    case "main":
      job = serviceLabel(FORMULA.main);
      break;
    default:
      job = null;
  }
  if (!job) return null;

  // kill:false — the old instance is exiting on its own. On a box where
  // KeepAlive is NOT parked, launchd may have already relaunched us by the
  // time this fires; -p leaves that healthy successor alone, where -k would
  // kill it mid-boot and start a third.
  return { job, plan: { command: "bash", args: ["-c", `sleep 2; ${kickstartLabel(job, { kill: false })}`], env: {} } };
}

/**
 * What to spawn so this server comes back after it exits — or null where the
 * service manager already does that reliably.
 *
 * A macOS tarball install has no fixed label (see launchd-label.ts), so the
 * caller must say which job it is running as; there is deliberately no default,
 * so a new call site has to decide. With null there is nothing safe to kick and
 * this returns null. prepareRelaunch is the caller that finds out.
 */
export function relaunchPlan(
  kind: InstallKind,
  appRoot: string,
  platform: NodeJS.Platform,
  tarballLabel: DaemonLabel | null,
): SpawnPlan | null {
  return kickFor(kind, appRoot, platform, tarballLabel)?.plan ?? null;
}

/** What exitForRestart set up, and — when it could not — why not. */
export interface RelaunchPrep {
  /** What to spawn; null when nothing is to be kicked. */
  plan: SpawnPlan | null;
  /** The launchd job the plan kicks, for the log. */
  job: string | null;
  /** Set when a launchd install needed a kick and no job could be found. */
  failure: string | null;
}

/**
 * relaunchPlan plus the work of finding out which job a macOS tarball install is.
 * Everything that touches the system arrives as an argument, so the decision runs
 * under test with the real code and a fake launchd.
 */
export function prepareRelaunch(
  kind: InstallKind,
  appRoot: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  probe: LabelProbe = launchctlProbe,
): RelaunchPrep {
  let tarballLabel: DaemonLabel | null = null;
  if (platform === "darwin" && kind === "tarball") {
    const found = resolveDaemonLabel(env, probe);
    if (!found.ok) return { plan: null, job: null, failure: found.reason };
    tarballLabel = found.label;
  }
  const kick = kickFor(kind, appRoot, platform, tarballLabel);
  return { plan: kick?.plan ?? null, job: kick?.job ?? null, failure: null };
}

/**
 * WHICH install this is, never its label.
 *
 * Returns a tag rather than a string so nothing derived from appRoot can reach a
 * command line. The caller turns the tag into a literal.
 */
function launchdKind(kind: InstallKind, appRoot: string): "tarball" | "beta" | "main" | null {
  if (kind === "tarball") return "tarball";
  if (kind !== "homebrew") return null;
  // The keg path names the formula, and the formula names the label. Matched on
  // a path segment so "stage-utility" inside "stage-utility-beta" cannot win by
  // being checked first.
  const segments = appRoot.split(/[\\/]+/);
  if (segments.includes(FORMULA.beta)) return "beta";
  if (segments.includes(FORMULA.main)) return "main";
  return null;
}

/**
 * The one way to exit when something else is expected to bring us back. Pairing
 * the kickstart with the exit structurally — rather than by remembering to call
 * two functions at every exit site — is what stops a future restart path from
 * wiring only half and reintroducing the parked-respawn blackout. The delay lets
 * the HTTP response that requested the restart flush first.
 *
 * `code` exists so a crash can use this too. server.ts's uncaughtException
 * handler exited 1 on its own, which is the blackout in full: on launchd the
 * exit is exactly what gets parked, so a synchronous throw took every display
 * dark with no route back but a shell. A crash still exits non-zero — the
 * supervisor should see a failure — it just no longer exits alone.
 *
 * Returns what it arranged. The exit goes ahead whatever it says — a crash must
 * still exit — so a failure to find the launchd job to kick is reported here and
 * on the log, never thrown.
 */
export function exitForRestart(delayMs: number, code = 0): RelaunchPrep {
  const prep = scheduleRelaunch();
  // Say so when nothing is coming. A config restore on a hand-run checkout
  // exited cleanly here and the log simply STOPPED mid-sentence — no error, no
  // stack, no last word — so the only available reading was "it crashed". It
  // had not crashed; it had done exactly what it was told, and nothing was
  // watching. One line is the difference between a mystery and a fact.
  if (!selfRecovers()) {
    console.warn(
      "[relaunch] exiting, and NOTHING will start this server again: no service " +
        "manager is known for this install kind. Start it again by hand.",
    );
  }
  setTimeout(() => process.exit(code), delayMs);
  return prep;
}

/**
 * Whether anything is expected to start this server again after it exits.
 *
 * Two independent ways to be sure, because neither alone is right:
 *
 * **Who started us.** systemd sets `INVOCATION_ID` on every unit it runs, and
 * launchd sets `XPC_SERVICE_NAME` on every job it manages. If one of those is in
 * the environment, a supervisor is watching whatever the code on disk looks like.
 *
 * **How it was installed.** A tarball (systemd / NSSM / launchd) or a Homebrew
 * install (launchd) is one we set up ourselves, so it is supervised even if the
 * environment is not passed through to us.
 *
 * The install kind ALONE would have been wrong, and wrong in the expensive
 * direction: the production box is a git checkout run under systemd. Judging by
 * kind would have told the operator that restoring a config there shuts the
 * server off permanently — a false alarm on the one machine where a false alarm
 * costs the most. What makes prod safe is its supervisor, not its file layout,
 * so that is what this asks about.
 *
 * Still pessimistic where it cannot tell: an unrecognised install with no
 * supervisor in the environment is assumed to have none.
 */
export function selfRecovers(
  kind: InstallKind = detectInstallKind(process.env, APP_ROOT, fs.existsSync),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (supervisorInEnv(env)) return true;
  return kind === "tarball" || kind === "homebrew";
}

/** The fingerprint a service manager leaves on our environment. */
function supervisorInEnv(env: NodeJS.ProcessEnv): boolean {
  // systemd, every unit, since v232. JOURNAL_STREAM comes with it when logs go
  // to the journal, which is the default and what install.sh's unit produces.
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) return true;
  // launchd sets this for managed jobs. "0" is what a plain login shell inherits
  // on macOS, so it means the opposite and must not count.
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0") return true;
  return false;
}

/** Everything scheduleRelaunch touches, so the real exit path runs under test. */
export interface RelaunchDeps {
  env: NodeJS.ProcessEnv;
  kind: InstallKind;
  appRoot: string;
  platform: NodeJS.Platform;
  probe: LabelProbe;
  spawn: (command: string, args: string[], options: SpawnOptions) => { unref(): void };
  log: Pick<Console, "log" | "error">;
}

/** Spawn the detached kickstart helper (survives our exit); a no-op off macOS
 *  and on unrecognised installs. */
export function scheduleRelaunch(deps: Partial<RelaunchDeps> = {}): RelaunchPrep {
  const env = deps.env ?? process.env;
  const appRoot = deps.appRoot ?? APP_ROOT;
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? console;
  const spawnChild = deps.spawn ?? spawn;
  const kind = deps.kind ?? detectInstallKind(env, appRoot, fs.existsSync);

  const prep = prepareRelaunch(kind, appRoot, platform, env, deps.probe);
  if (prep.failure) {
    // Loud on purpose: the exit that follows is the one launchd may park, so a
    // box that cannot name its own job is a box that may stay dark.
    log.error(
      `[relaunch] cannot kick this server back up through launchd: ${prep.failure}. ` +
        "Nothing was scheduled; if launchd leaves it stopped, start it by hand.",
    );
  }
  if (!prep.plan) return prep;
  log.log(`[relaunch] launchd parks KeepAlive respawns — kickstarting job ${prep.job} after exit: ${prep.plan.args.at(-1)}`);
  const child = spawnChild(prep.plan.command, prep.plan.args, {
    detached: true,
    stdio: "ignore",
    env: { ...env, ...prep.plan.env },
  });
  child.unref();
  return prep;
}
