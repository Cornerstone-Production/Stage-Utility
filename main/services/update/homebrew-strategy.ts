// homebrew-strategy.ts — updating a Homebrew install.
//
// Brew owns the Cellar, so the app never writes into the keg. Everything here
// delegates, which keeps `brew info` honest and means a later `brew upgrade`
// cannot fight whatever the app did.
//
// Track switching is the one path in this design that stops the service before
// its work is finished: swapping formula is inherently uninstall-then-install.
// That is acceptable only because it is macOS-only, where a detached child was
// verified to survive `launchctl bootout` (the teardown `brew services stop`
// performs). It does not license a stop-first path anywhere else.
//
// Data survives a switch: it lives in $(brew --prefix)/var/stage-utility, outside
// the keg, and `brew uninstall` removes the keg only.

import * as fs from "node:fs";

import type { InstallKind } from "./install-kind.js";
import type { ApplyOptions, SpawnPlan, UpdateStrategy } from "./strategy.js";

/**
 * A launchd agent inherits a minimal PATH that usually lacks brew, so it is
 * resolved by absolute path: Apple silicon first, then Intel.
 */
export const BREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

export const FORMULA = { main: "stage-utility", beta: "stage-utility-beta" } as const;

export class HomebrewStrategy implements UpdateStrategy {
  readonly kind: InstallKind = "homebrew";

  constructor(private readonly exists: (p: string) => boolean = fs.existsSync) {}

  private brew(): string | null {
    return BREW_PATHS.find((p) => this.exists(p)) ?? null;
  }

  canApply(): { ok: true } | { ok: false; reason: string } {
    if (!this.brew()) {
      return { ok: false, reason: `Could not find brew. Looked in: ${BREW_PATHS.join(", ")}.` };
    }
    return { ok: true };
  }

  plan(o: ApplyOptions): SpawnPlan {
    const brew = this.brew() ?? BREW_PATHS[0];
    const target = o.track === "beta" ? FORMULA.beta : FORMULA.main;
    const other = target === FORMULA.beta ? FORMULA.main : FORMULA.beta;

    // `brew update` first in both cases: without it brew never sees new versions
    // of a third-party tap and reports everything as current.
    //
    // Switching resolves the target BEFORE uninstalling, so a formula that does
    // not exist fails while the current one is still installed. Uninstalling
    // stops the agent, so the new formula's service is started explicitly -
    // otherwise the switch completes with nothing running.
    const script = o.checkout
      ? [
          `${brew} update`,
          `${brew} info ${target} >/dev/null`,
          `${brew} uninstall ${other} || true`,
          `${brew} install ${target}`,
          `${brew} services start ${target}`,
        ].join(" && ")
      : [`${brew} update`, `${brew} upgrade ${target}`, `${brew} services restart ${target}`].join(
          " && ",
        );

    return { command: "bash", args: ["-c", script], env: { ...o.env } };
  }
}
