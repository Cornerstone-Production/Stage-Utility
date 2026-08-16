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

import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { APP_ROOT } from "../app-root.js";
import { detectInstallKind, type InstallKind } from "./install-kind.js";
import { FORMULA, kickstartLabel, serviceLabel } from "./homebrew-strategy.js";
import type { SpawnPlan } from "./strategy.js";

/** The label install.sh registers for a macOS tarball install. */
export const TARBALL_DAEMON_LABEL = "com.cornerstone.stage-utility";

/**
 * What to spawn so this server comes back after it exits — or null where the
 * service manager already does that reliably (everything that is not launchd).
 *
 * The command itself is kickstartLabel — the same one the Homebrew update path
 * uses, for the same reasons (see its doc for why `-k -p`, and why it tries gui
 * before system and never fails). The sleep puts the kickstart safely after our
 * own exit; if we are already gone, -k is a no-op.
 */
export function relaunchPlan(kind: InstallKind, appRoot: string, platform: NodeJS.Platform): SpawnPlan | null {
  if (platform !== "darwin") return null;

  const label = launchdLabel(kind, appRoot);
  if (!label) return null;

  // kill:false — the old instance is exiting on its own. On a box where
  // KeepAlive is NOT parked, launchd may have already relaunched us by the
  // time this fires; -p leaves that healthy successor alone, where -k would
  // kill it mid-boot and start a third.
  return { command: "bash", args: ["-c", `sleep 2; ${kickstartLabel(label, { kill: false })}`], env: {} };
}

/** Our own launchd label, or null when nothing here recognises the install. */
function launchdLabel(kind: InstallKind, appRoot: string): string | null {
  if (kind === "tarball") return TARBALL_DAEMON_LABEL;
  if (kind !== "homebrew") return null;
  // The keg path names the formula, and the formula names the label. Matched on
  // a path segment so "stage-utility" inside "stage-utility-beta" cannot win by
  // being checked first.
  const segments = appRoot.split(/[\\/]+/);
  if (segments.includes(FORMULA.beta)) return serviceLabel(FORMULA.beta);
  if (segments.includes(FORMULA.main)) return serviceLabel(FORMULA.main);
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
 */
export function exitForRestart(delayMs: number, code = 0): void {
  scheduleRelaunch();
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

/** Spawn the detached kickstart helper (survives our exit); a no-op off macOS
 *  and on unrecognised installs. */
function scheduleRelaunch(): void {
  const plan = relaunchPlan(detectInstallKind(process.env, APP_ROOT, fs.existsSync), APP_ROOT, process.platform);
  if (!plan) return;
  console.log(`[relaunch] launchd parks KeepAlive respawns — scheduling: ${plan.args.at(-1)}`);
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...plan.env },
  });
  child.unref();
}
