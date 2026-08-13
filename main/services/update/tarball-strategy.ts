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
export const INSTALLER_SH = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
export const INSTALLER_PS1 = `https://raw.githubusercontent.com/${REPO}/main/install.ps1`;

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
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALLER_PS1} | iex`],
        env,
        // Not the install root: the installer replaces it under this process.
        cwd: "C:\\",
      };
    }
    // Not the install root: the installer replaces it under this process.
    return { command: "bash", args: ["-c", `curl -fsSL ${INSTALLER_SH} | bash`], env, cwd: "/" };
  }
}
