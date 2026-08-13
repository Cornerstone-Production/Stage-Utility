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
 * The one way to exit for a deliberate restart. Pairing the kickstart with the
 * exit structurally — rather than by remembering to call two functions at every
 * exit site — is what stops a future restart path from wiring only half and
 * reintroducing the parked-respawn blackout. The delay lets the HTTP response
 * that requested the restart flush first.
 */
export function exitForRestart(delayMs: number): void {
  scheduleRelaunch();
  setTimeout(() => process.exit(0), delayMs);
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
