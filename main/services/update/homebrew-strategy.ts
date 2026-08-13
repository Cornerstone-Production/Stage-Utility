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

/** launchd's label for a formula's service. */
const label = (formula: string): string => `homebrew.mxcl.${formula}`;

/**
 * Clear a leftover registration for a label before brew tries to load it.
 *
 * `brew services start` shells out to `launchctl bootstrap`, which REFUSES a
 * label already registered in the domain — "Bootstrap failed: 5: Input/output
 * error". Uninstalling a formula does not always unregister it, so a track
 * switch could leave the old label behind and every subsequent start failed with
 * that error. Expected to fail when nothing is registered, hence `|| true`.
 */
const bootout = (formula: string): string =>
  `(launchctl bootout "gui/$(id -u)/${label(formula)}" 2>/dev/null || ` +
  `launchctl bootout "system/${label(formula)}" 2>/dev/null || true; ` +
  // Then confirm the label has actually gone before anyone bootstraps it.
  //
  // Honest about what this is: a cheap guard, not a proven fix. launchd documents
  // bootout as asynchronous, but a controlled probe (bootout then immediately
  // bootstrap, 5 iterations against a throwaway agent) failed to reproduce a race
  // — 0/5 either way. The loop exits on the first check when the label is already
  // gone, which is the normal case, so it costs nothing and removes one variable
  // from a failure that is otherwise miserable to diagnose.
  `for _ in $(seq 1 40); do ` +
  `launchctl print "gui/$(id -u)/${label(formula)}" >/dev/null 2>&1 || break; ` +
  `sleep 0.25; done)`;

/**
 * Force the initial spawn after brew has loaded the job.
 *
 * `brew services start` only bootstraps the agent; launchd then decides when to
 * honour RunAtLoad. Outside a foreground GUI session it parks it — launchd
 * reports `runs = 0` with `pended nondemand spawn = speculative` — so brew
 * reports success and nothing ever runs. KeepAlive does not rescue this: it
 * restarts a job that has exited, and this one never started.
 *
 * The updater is exactly such a session, so a track switch would otherwise
 * complete with the service "started" and nothing listening. kickstart demands
 * the start explicitly, which is not subject to that deferral.
 *
 * `-k` KILLS a running instance first. Without it, `-p` alone means "start if
 * not running", so a process that survived the upgrade is left alone — and
 * `brew upgrade` deletes the old keg out from under it. That happened: the
 * server went on running from a directory that no longer existed, serving
 * version 0.0.0 with no settings or control page, because node keeps its own
 * binary's inode open while every file it reads has gone.
 *
 * Best-effort across both domains, and never fatal: an install whose service is
 * already running must not report failure because the label sits elsewhere.
 */
const kickstart = (formula: string): string =>
  `(launchctl kickstart -k -p "gui/$(id -u)/${label(formula)}" 2>/dev/null || ` +
  `launchctl kickstart -k -p "system/${label(formula)}" 2>/dev/null || true)`;

/**
 * Report the run's outcome through the same result-file protocol install.sh and
 * update.sh use — it is what lets the UI leave the "updating" phase. A brew run
 * that failed without writing one left the page waiting forever on a run that
 * was already dead. No-op when the env var is absent (a human at a terminal).
 */
const writeResult = (ok: boolean, error: string): string =>
  `if [ -n "$STAGE_UPDATE_RESULT" ]; then ` +
  `printf '{"ok":%s,"error":"%s","at":"%s"}' ${ok} "${error}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE_UPDATE_RESULT"; fi`;

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
    //
    // The update path only restarts when the keg actually changed. The check
    // reads GitHub releases while brew installs from the tap, so during the
    // window where a release exists but the formula has not been regenerated
    // yet, `brew upgrade` is a no-op — and restarting after one kills the
    // server (blanking every display) to deliver nothing, once per scheduled
    // window until the tap catches up. Reported as a failed run so the UI
    // says why nothing changed instead of pretending an update landed.
    //
    // writeResult(true) comes BEFORE the restart, same as install.sh's swap
    // mode: the restart kills the server, and the result file must already
    // say "done" when the reconnecting page asks.
    const script = o.checkout
      ? [
          [
            `${brew} update`,
            `${brew} info ${target} >/dev/null`,
            bootout(other),
            `${brew} uninstall ${other} || true`,
            `${brew} install ${target}`,
            // The incoming formula needs its own label cleared too: switching back
            // and forth leaves a registration behind each time, and the second
            // switch to a track would otherwise fail to bootstrap.
            bootout(target),
            writeResult(true, ""),
            `${brew} services start ${target}`,
            kickstart(target),
          ].join(" && "),
          " || { ",
          writeResult(false, "brew track switch failed - see update.log"),
          "; }",
        ].join("")
      : [
          [
            `${brew} update`,
            `before=$(${brew} list --versions ${target})`,
            `${brew} upgrade ${target}`,
            `after=$(${brew} list --versions ${target})`,
            `if [ "$before" = "$after" ]; then ` +
              writeResult(
                false,
                "brew has no newer build yet - the tap usually catches up within minutes of a release. Nothing was restarted.",
              ) +
              `; exit 0; fi`,
            // Clear the target's OWN registration before starting it again.
            //
            // This path had no bootout at all, and that is the bug behind "it never
            // comes back after an update". A stale registration for this label makes
            // every `brew services start` fail with "Bootstrap failed: 5", and the
            // kickstart below cannot rescue a job that was never bootstrapped. The
            // registration outlives `brew uninstall` — which does NOT unregister a
            // service — so once one is orphaned it breaks every future install and
            // upgrade, permanently, until something boots it out.
            bootout(target),
            writeResult(true, ""),
            `${brew} services restart ${target}`,
            kickstart(target),
          ].join(" && "),
          " || { ",
          writeResult(false, "brew upgrade failed - see update.log"),
          "; }",
        ].join("");

    // "/" and not the keg: brew deletes the old keg mid-run (see SpawnPlan.cwd).
    return { command: "bash", args: ["-c", script], env: { ...o.env }, cwd: "/" };
  }
}
