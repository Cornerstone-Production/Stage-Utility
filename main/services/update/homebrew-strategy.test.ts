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

  it("switches back to stable the same way", () => {
    const line = new HomebrewStrategy(brewAt(BREW_PATHS[0]))
      .plan({ ...base, track: "main", checkout: true })
      .args.join(" ");
    assert.ok(line.includes(`uninstall ${FORMULA.beta}`));
    assert.ok(line.includes(`install ${FORMULA.main}`));
  });
});
