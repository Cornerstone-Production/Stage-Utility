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
    for (const frag of line.split(" && ").filter((s) => /kickstart|bootout/.test(s))) {
      assert.ok(frag.trimEnd().endsWith("|| true)"), `must be best-effort: ${frag}`);
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
