// tarball-strategy.ts — updating a one-line-installer install.
//
// The installer is FETCHED at update time rather than shipped in the archive. A
// vendored copy would mean the PREVIOUS release's installer performs every
// upgrade, capping how fast an installer fix reaches anyone; fetching is also the
// identical path the documented one-liner uses, so there is one tested code path
// rather than two.
//
// Every platform runs the same shape. An earlier design ran Linux work in a
// transient systemd scope to escape the unit's cgroup, but that was solving a
// problem this ordering does not create: the cgroup only tears down because
// something called `systemctl stop`, and swap mode never does.

import type { InstallKind } from "./install-kind.js";
import type { ApplyOptions, SpawnPlan, UpdateStrategy } from "./strategy.js";

const REPO = "Cornerstone-Production/Stage-Utility";

/**
 * The installer for a track comes from that track's branch.
 *
 * It used to always come from `main`, on the reasoning that the newest
 * installer should perform every upgrade. That is right for a stable box and
 * wrong for a beta one: `main` only moves when a release is cut, so an
 * installer fix that has shipped to beta does not reach a beta install for
 * days or weeks — and the fix it is missing may be the one that lets it
 * install at all.
 *
 * That is not hypothetical. A SIGPIPE on the (much larger) beta release JSON
 * broke `STAGE_TRACK=beta` installs entirely; the fix went to beta, beta
 * released it, and the next attempt failed identically — because the script
 * doing the installing was still main's.
 *
 * A beta box running beta's installer is also just what "beta" means: it is
 * where installer changes get exercised before a stable box ever sees them.
 */
export function installerUrl(track: string, platform: NodeJS.Platform): string {
  const branch = track === "beta" ? "beta" : "main";
  const file = platform === "win32" ? "install.ps1" : "install.sh";
  return `https://raw.githubusercontent.com/${REPO}/${branch}/${file}`;
}

export class TarballStrategy implements UpdateStrategy {
  readonly kind: InstallKind = "tarball";

  constructor(private readonly platform: NodeJS.Platform) {}

  /**
   * Nothing to check up front: the installer is fetched, and swap mode needs no
   * tooling beyond what already runs the server. A fetch that fails is reported
   * by the installer through the result file, which is what lets the UI leave the
   * updating phase instead of waiting forever.
   */
  canApply(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }

  plan(o: ApplyOptions): SpawnPlan {
    const env = {
      ...o.env,
      STAGE_TRACK: o.track,
      // Stage and swap while the server keeps serving, then signal it to exit.
      // Without this the installer would stop the service first, blanking every
      // display for the whole download and - on systemd - tearing down the
      // cgroup this process runs in, killing the update midway.
      STAGE_UPDATE_MODE: "swap",
      ...(o.version ? { STAGE_VERSION: o.version } : {}),
    };

    if (this.platform === "win32") {
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `irm ${installerUrl(o.track, "win32")} | iex`,
        ],
        env,
        // Not the install root: the installer replaces it under this process.
        cwd: "C:\\",
      };
    }
    // Not the install root: the installer replaces it under this process.
    return {
      command: "bash",
      args: ["-c", `curl -fsSL ${installerUrl(o.track, this.platform)} | bash`],
      env,
      cwd: "/",
    };
  }
}
