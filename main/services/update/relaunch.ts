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
import { FORMULA } from "./homebrew-strategy.js";
import type { SpawnPlan } from "./strategy.js";

/** The label install.sh registers for a macOS tarball install. */
export const TARBALL_DAEMON_LABEL = "com.cornerstone.stage-utility";

/**
 * What to spawn so this server comes back after it exits — or null where the
 * service manager already does that reliably (everything that is not launchd).
 *
 * `-k -p` on purpose: -p demands the spawn (immune to parking), -k first kills
 * an instance that somehow did not exit, so the helper can never leave two
 * servers racing for the port. The sleep puts the kickstart safely after our
 * own exit; if we are already gone, -k is a no-op.
 */
export function relaunchPlan(
  kind: InstallKind,
  appRoot: string,
  platform: NodeJS.Platform,
): SpawnPlan | null {
  if (platform !== "darwin") return null;

  let label: string | null = null;
  if (kind === "homebrew") {
    // The keg path names the formula, and the formula names the label. Matched
    // on a path segment so "stage-utility" inside "stage-utility-beta" cannot
    // win by being checked first.
    const segments = appRoot.split(/[\\/]+/);
    if (segments.includes(FORMULA.beta)) label = `homebrew.mxcl.${FORMULA.beta}`;
    else if (segments.includes(FORMULA.main)) label = `homebrew.mxcl.${FORMULA.main}`;
  } else if (kind === "tarball") {
    label = TARBALL_DAEMON_LABEL;
  }
  if (!label) return null;

  const kick = (domain: string) => `launchctl kickstart -k -p "${domain}/${label}" 2>/dev/null`;
  return {
    command: "bash",
    // gui first (brew services as a user), then system (the installer's root
    // daemon, and `sudo brew services`). Never fails: if both domains refuse,
    // we are no worse off than exit-and-pray was.
    args: ["-c", `sleep 2; ${kick(`gui/$(id -u)`)} || ${kick("system")} || true`],
    env: {},
  };
}

/**
 * Call IMMEDIATELY BEFORE scheduling a deliberate process.exit(0). Detached, so
 * it survives our exit; a no-op off macOS and on unrecognised installs.
 */
export function scheduleRelaunch(): void {
  const plan = relaunchPlan(
    detectInstallKind(process.env, APP_ROOT, fs.existsSync),
    APP_ROOT,
    process.platform,
  );
  if (!plan) return;
  console.log(`[relaunch] launchd parks KeepAlive respawns — scheduling a kickstart of this label`);
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}
