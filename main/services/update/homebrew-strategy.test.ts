import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BREW_PATHS, FORMULA, HomebrewStrategy } from "./homebrew-strategy.js";

const noBrew = () => false;
const brewAt = (want: string) => (p: string) => p === want;
const base = { track: "main", checkout: false, deferRestart: false, version: null, env: {} };

describe("HomebrewStrategy", () => {
  it("refuses when brew cannot be found, naming where it looked", () => {
    const r = new HomebrewStrategy(noBrew).canApply();
    assert.equal(r.ok, false);
    for (const p of BREW_PATHS) {
      assert.ok((r as { ok: false; reason: string }).reason.includes(p), `must name ${p}`);
    }
  });

  it("finds brew on Apple silicon and on Intel", () => {
    assert.equal(new HomebrewStrategy(brewAt(BREW_PATHS[0])).canApply().ok, true);
    assert.equal(new HomebrewStrategy(brewAt(BREW_PATHS[1])).canApply().ok, true);
  });

  it("uses the absolute brew path, since a launchd agent has a minimal PATH", () => {
    const p = new HomebrewStrategy(brewAt(BREW_PATHS[1])).plan(base);
    assert.ok(p.args.join(" ").includes(BREW_PATHS[1]), "must invoke brew by absolute path");
  });

  it("updates in place with brew upgrade, never uninstalling", () => {
    const line = new HomebrewStrategy(brewAt(BREW_PATHS[0])).plan(base).args.join(" ");
    assert.ok(line.includes("brew update"), "must refresh the tap first");
    assert.ok(line.includes(`upgrade ${FORMULA.main}`));
    assert.ok(!line.includes("uninstall"), "a same-track update must not uninstall");
  });

  it("switches tracks by resolving the target BEFORE uninstalling anything", () => {
    const line = new HomebrewStrategy(brewAt(BREW_PATHS[0]))
      .plan({ ...base, track: "beta", checkout: true })
      .args.join(" ");
    const resolve = line.indexOf(`info ${FORMULA.beta}`);
    const uninstall = line.indexOf("uninstall");
    assert.ok(resolve >= 0, "must resolve the target formula");
    assert.ok(uninstall > resolve, "resolve must happen before uninstall");
  });

  it("uninstalls the other formula, not the one it is installing", () => {
    const line = new HomebrewStrategy(brewAt(BREW_PATHS[0]))
      .plan({ ...base, track: "beta", checkout: true })
      .args.join(" ");
    assert.ok(line.includes(`uninstall ${FORMULA.main}`));
    assert.ok(line.includes(`install ${FORMULA.beta}`));
  });

  it("restarts the service after switching, since uninstall stops the agent", () => {
    const line = new HomebrewStrategy(brewAt(BREW_PATHS[0]))
      .plan({ ...base, track: "beta", checkout: true })
      .args.join(" ");
    assert.ok(line.includes(`services start ${FORMULA.beta}`), "switch must leave it running");
  });

  it("kickstarts the service after starting it, on both paths", () => {
    // brew only bootstraps the agent; outside a foreground GUI session launchd
    // parks the RunAtLoad spawn (runs = 0, "pended nondemand spawn"), so brew
    // reports success and nothing runs. The updater is such a session.
    for (const opts of [base, { ...base, track: "beta", checkout: true }]) {
      const line = new HomebrewStrategy(brewAt(BREW_PATHS[0])).plan(opts).args.join(" ");
      const formula = opts.checkout ? FORMULA.beta : FORMULA.main;
      assert.ok(line.includes(`kickstart -k -p "gui/$(id -u)/homebrew.mxcl.${formula}"`), "must force the spawn");
      // -k is load-bearing: -p alone is "start if not running", so a process that
      // survived the upgrade keeps serving from the keg brew just deleted.
      assert.ok(!/kickstart -p /.test(line), "kickstart must kill a running instance first");
      const started = Math.max(line.indexOf("services start"), line.indexOf("services restart"));
      assert.ok(line.indexOf("kickstart") > started, "kickstart must come after brew starts it");
    }
  });

  it("boots out the old label before uninstalling, so bootstrap cannot fail with EIO", () => {
    // launchctl bootstrap refuses a label already registered in the domain, and
    // uninstall does not always unregister it — that left every later start
    // failing with "Bootstrap failed: 5: Input/output error".
    const line = new HomebrewStrategy(brewAt(BREW_PATHS[0]))
      .plan({ ...base, track: "beta", checkout: true })
      .args.join(" ");
    const boot = line.indexOf(`bootout "gui/$(id -u)/homebrew.mxcl.${FORMULA.main}"`);
    assert.ok(boot >= 0, "must clear the outgoing formula's registration");
    assert.ok(boot < line.indexOf("uninstall"), "bootout must precede uninstall");
  });

  it("never lets a kickstart or bootout failure fail the update", () => {
    // A service already running, or a label in the other domain, must not turn a
    // successful install into a reported failure.
    const line = new HomebrewStrategy(brewAt(BREW_PATHS[0]))
      .plan({ ...base, track: "beta", checkout: true })
      .args.join(" ");
    // The property that matters is that the group cannot fail the chain, not the
    // exact text: bootout now ends with a wait loop rather than `|| true`, and a
    // for-loop exits 0 regardless of what happened inside it. The chain's own
    // trailing `|| { …failure report… }` is not part of any group — strip it
    // before asserting.
    for (const frag of line.split(" && ").filter((s) => /kickstart|bootout/.test(s))) {
      const t = frag.replace(/ \|\| \{ .*$/, "").trimEnd();
      assert.ok(
        t.endsWith("|| true)") || t.endsWith("done)"),
        `must not be able to fail the update: ${frag}`,
      );
      assert.ok(t.includes("|| true"), `must swallow its own failure: ${frag}`);
    }
  });

  it("switches back to stable the same way", () => {
    const line = new HomebrewStrategy(brewAt(BREW_PATHS[0]))
      .plan({ ...base, track: "main", checkout: true })
      .args.join(" ");
    assert.ok(line.includes(`uninstall ${FORMULA.beta}`));
    assert.ok(line.includes(`install ${FORMULA.main}`));
  });
});

describe("HomebrewStrategy — the stale-registration failures", () => {
  const line = (over = {}) =>
    new HomebrewStrategy(brewAt(BREW_PATHS[0])).plan({ ...base, ...over }).args.join(" ");

  it("boots out the TARGET's own label before starting it, on a plain upgrade", () => {
    // The bug behind "it never comes back after an update": this path had no
    // bootout at all. `brew uninstall` does not unregister a service, so an
    // orphaned label makes every later `brew services start` fail with
    // "Bootstrap failed: 5" — permanently, across reinstalls — and kickstart
    // cannot rescue a job that was never bootstrapped.
    const l = line();
    const boot = l.indexOf(`bootout "gui/$(id -u)/homebrew.mxcl.${FORMULA.main}"`);
    assert.ok(boot >= 0, "an upgrade must clear its own stale registration");
    assert.ok(boot < l.indexOf("services restart"), "bootout must precede the start");
  });

  it("confirms the label has gone before bootstrapping", () => {
    // A guard, not a proven fix: a controlled probe could not reproduce a
    // bootout/bootstrap race (0/5 either way). It exits on the first check in the
    // normal case, so it costs nothing and removes a variable from a failure that
    // is otherwise miserable to diagnose.
    for (const l of [line(), line({ track: "beta", checkout: true })]) {
      assert.match(l, /launchctl print .*>\/dev\/null 2>&1 \|\| break/, "must poll until it clears");
      assert.match(l, /sleep 0\.25/, "must back off between polls");
    }
  });

  it("still boots out the OUTGOING formula when switching tracks", () => {
    const l = line({ track: "beta", checkout: true });
    assert.ok(l.includes(`bootout "gui/$(id -u)/homebrew.mxcl.${FORMULA.main}"`));
    assert.ok(l.includes(`bootout "gui/$(id -u)/homebrew.mxcl.${FORMULA.beta}"`));
  });
});

describe("HomebrewStrategy — no-op upgrades and failure reporting", () => {
  const line = (over = {}) =>
    new HomebrewStrategy(brewAt(BREW_PATHS[0])).plan({ ...base, ...over }).args.join(" ");

  it("skips the restart when brew had nothing newer, and says so through the result file", () => {
    // The check reads GitHub releases; brew installs from the tap. In the window
    // where the tap lags a release, `brew upgrade` is a no-op — and restarting
    // after one kills the server (blanking every display) to deliver nothing.
    const l = line();
    assert.match(l, /before=\$\(.*list --versions/, "must capture the version before upgrading");
    assert.match(l, /after=\$\(.*list --versions/, "must capture the version after upgrading");
    const noopAt = l.indexOf('[ "$before" = "$after" ]');
    const noop = l.slice(noopAt);
    const noopBody = noop.slice(0, noop.indexOf("exit 0"));
    assert.ok(noopBody.includes("no newer build yet"), "the no-op must report why");
    assert.ok(!noopBody.includes("services restart"), "an unchanged keg must not restart anything");
    // Positional: the no-op check must gate the real restart, not follow it.
    assert.ok(noopAt < l.lastIndexOf("services restart"), "the no-op exit must precede the restart");
  });

  it("a failed `brew update` reports and stops — it never touched the service", () => {
    // Offline box, DNS hiccup, rate limit: restarting here would bounce a
    // healthy server once per scheduled window for as long as the tap is
    // unreachable — the no-op bug, offline edition.
    const l = line();
    const at = l.indexOf("brew update || {");
    assert.ok(at >= 0, "brew update failure must be its own branch");
    const body = l.slice(at, l.indexOf("exit 0; }", at));
    assert.ok(body.includes("could not refresh the tap"), "must say what failed");
    assert.ok(!body.includes("services restart"), "must not bounce a server brew never stopped");
  });

  it("a failed upgrade restarts ONLY a service brew actually stopped, and reports afterwards", () => {
    // The real beta.20→28 upgrade: brew swapped the keg, stopped the service,
    // exited non-zero, and the old && chain skipped the restart it still owed.
    const l = line();
    const failed = l.slice(l.indexOf('[ "$brew_rc" -ne 0 ]'));
    const failedBody = failed.slice(0, failed.indexOf("exit 0"));
    assert.match(failedBody, /grep -q "state = running"/, "must check whether brew stopped it");
    assert.ok(failedBody.includes("The service was not interrupted."), "a running service reports untouched");
    assert.ok(failedBody.includes("services restart"), "a stopped service still gets the restart it is owed");
    // The "was restarted" claim must come AFTER the restart attempt, not before.
    assert.ok(
      failedBody.indexOf("services restart") < failedBody.indexOf("restarted on the version already installed"),
      "must not claim a restart that has not happened yet",
    );
  });

  it("kickstart is not chained on brew's restart exit code", () => {
    // `brew services restart` can bootstrap the job and still exit non-zero —
    // an && would then skip the one command that demands the parked spawn.
    const l = line();
    assert.match(l, /services restart \S+; services_rc=\$\?; \(launchctl kickstart/, "kickstart must run regardless");
  });

  it("writes the ok result BEFORE the restart that kills the server, then corrects it only if the service is truly down", () => {
    const l = line();
    const ok = l.indexOf('printf \'{"ok":%s,"finishedAt":"%s","log":"%s"}\' true');
    const finalRestart = l.lastIndexOf("services restart");
    assert.ok(ok >= 0 && ok < finalRestart, "the result must exist when the page reconnects");
    const tail = l.slice(finalRestart);
    assert.match(tail, /if \[ "\$services_rc" -ne 0 \] && ! .*state = running/, "correction requires BOTH a failed restart and a dead service");
    assert.ok(tail.includes("did not restart"), "a dead service must not read as a success");
  });

  it("a failed track switch reports through the result file instead of leaving the UI waiting forever", () => {
    const l = line({ track: "beta", checkout: true });
    assert.match(l, /\|\| \{ if \[ -n "\$STAGE_UPDATE_RESULT" \]; then printf .*false.*track switch failed/, "switch must report failure");
  });

  it("captures brew's output into update.log, so a failed run is diagnosable", () => {
    // The script runs detached with stdio ignored; without this a failure
    // leaves NOTHING — the real beta.20→28 failure had to be diagnosed from
    // filesystem archaeology.
    for (const l of [line(), line({ track: "beta", checkout: true })]) {
      assert.match(l, /exec >> "\$STAGE_UPDATE_LOG" 2>&1/, "all output must land in update.log");
    }
  });
});
