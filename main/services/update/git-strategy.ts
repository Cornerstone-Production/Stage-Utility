// git-strategy.ts — updating a source checkout.
//
// This is the behaviour the app has always had, moved behind the interface
// unchanged: scripts/update.sh pulls, reinstalls if the lockfile moved, builds,
// and kills the server so the service manager relaunches it.
//
// Worth preserving deliberately: update.sh does every slow step while the server
// keeps serving and signals it only as its final action. Displays stay up for the
// whole pull and build; the outage is one restart. Every other strategy follows
// that same ordering.

import * as fs from "node:fs";
import * as path from "node:path";

import type { InstallKind } from "./install-kind.js";
import type { ApplyOptions, SpawnPlan, UpdateStrategy } from "./strategy.js";

export class GitStrategy implements UpdateStrategy {
  readonly kind: InstallKind = "git";

  constructor(
    private readonly appRoot: string,
    /** Injected so the Windows branch is reachable from a test on any host. */
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly exists: (p: string) => boolean = fs.existsSync,
  ) {}

  private script(): string {
    const name = this.platform === "win32" ? "update.ps1" : "update.sh";
    return path.join(this.appRoot, "scripts", name);
  }

  canApply(): { ok: true } | { ok: false; reason: string } {
    if (!this.exists(this.script())) {
      return { ok: false, reason: `No update script at ${this.script()}.` };
    }
    if (!this.exists(path.join(this.appRoot, ".git"))) {
      return { ok: false, reason: "This is not a git checkout." };
    }
    return { ok: true };
  }

  plan(o: ApplyOptions): SpawnPlan {
    const env = {
      ...o.env,
      STAGE_UPDATE_BRANCH: o.track,
      STAGE_UPDATE_CHECKOUT: o.checkout ? "1" : "",
      STAGE_UPDATE_DEFER_RESTART: o.deferRestart ? "1" : "",
      ...(o.version ? { STAGE_UPDATE_TAG: o.version } : {}),
    };
    // update.ps1 is PowerShell, not bash. The pre-refactor updater branched on
    // platform here; losing that would break Windows checkouts silently.
    if (this.platform === "win32") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script()],
        env,
      };
    }
    return { command: "bash", args: [this.script()], env };
  }
}
