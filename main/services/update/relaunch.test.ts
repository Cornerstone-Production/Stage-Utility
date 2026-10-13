import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareRelaunch, relaunchPlan } from "./relaunch.js";
import { DAEMON_LABEL, KNOWN_DAEMON_LABELS, LEGACY_DAEMON_LABELS } from "./launchd-label.js";
import { FORMULA } from "./homebrew-strategy.js";

// The regression this guards: "restart" meant exit(0) and let the service
// manager relaunch us — but launchd PARKS nondemand spawns ("pended nondemand
// spawn = inefficient"), so a Homebrew box that restarted for a config restore
// simply never came back. Observed live 2026-08-13.

const BETA_KEG = `/opt/homebrew/Cellar/${FORMULA.beta}/1.10.0-beta.28/libexec`;
const MAIN_KEG = `/opt/homebrew/Cellar/${FORMULA.main}/1.9.5/libexec`;

describe("relaunchPlan", () => {
  it("kickstarts the beta formula's label on a Homebrew beta install", () => {
    const p = relaunchPlan("homebrew", BETA_KEG, "darwin");
    assert.ok(p, "must plan a relaunch on launchd");
    // Every kick target, extracted — not substring absence, which "-beta"
    // containing "stage-utility" would satisfy under any quoting change.
    const targets = [...p.args.join(" ").matchAll(/-p "[^"]*\/([^"]+)"/g)].map((m) => m[1]);
    assert.ok(targets.length >= 2, "must try both domains");
    for (const t of targets) assert.equal(t, `homebrew.mxcl.${FORMULA.beta}`);
  });

  it("matches the formula on a path segment, so main cannot win inside the beta keg's name", () => {
    const p = relaunchPlan("homebrew", MAIN_KEG, "darwin");
    assert.ok(p!.args.join(" ").includes(`homebrew.mxcl.${FORMULA.main}`));
  });

  it("kickstarts whichever daemon label the caller resolved on a macOS tarball install", () => {
    for (const label of KNOWN_DAEMON_LABELS) {
      const p = relaunchPlan("tarball", "/usr/local/stage-utility/current", "darwin", label);
      const targets = [...p!.args.join(" ").matchAll(/-p "[^"]*\/([^"]+)"/g)].map((m) => m[1]);
      assert.ok(targets.length >= 2, "must try both domains");
      for (const t of targets) assert.equal(t, label);
    }
  });

  it("a macOS tarball install with no resolved label plans nothing rather than kicking a guess", () => {
    assert.equal(relaunchPlan("tarball", "/usr/local/stage-utility/current", "darwin"), null);
  });

  it("demands the spawn WITHOUT killing: -p only, both domains, never fatal", () => {
    // -p is "start if not running": if KeepAlive already relaunched the server
    // (a box where launchd did not park it), the healthy successor is left
    // alone. -k here would kill it mid-boot and start a third instance.
    const s = relaunchPlan("homebrew", BETA_KEG, "darwin")!.args.join(" ");
    assert.match(s, /kickstart -p "gui\/\$\(id -u\)\//, "gui domain for brew services as a user");
    assert.match(s, /kickstart -p "system\//, "system domain for a root daemon");
    assert.ok(!s.includes("-k"), "must not kill a successor KeepAlive already started");
    assert.ok(s.trimEnd().endsWith("|| true"), "a failed kickstart must not become a crash");
  });

  it("sleeps past our own exit before kicking", () => {
    const script = relaunchPlan("tarball", "/usr/local/stage-utility/current", "darwin", DAEMON_LABEL)!.args.at(-1)!;
    assert.match(script, /^sleep [0-9]/);
  });

  it("plans nothing where the service manager already relaunches reliably", () => {
    // systemd has Restart=always; Task Scheduler has RestartCount.
    assert.equal(relaunchPlan("tarball", "/opt/stage-utility/current", "linux"), null);
    assert.equal(relaunchPlan("tarball", "C:\\Program Files\\Stage Utility\\current", "win32"), null);
    assert.equal(relaunchPlan("git", "/Users/x/stage-utility", "darwin"), null);
    assert.equal(relaunchPlan("unknown", "/somewhere", "darwin"), null);
  });

  it("an unrecognisable keg path plans nothing rather than kicking a guessed label", () => {
    assert.equal(relaunchPlan("homebrew", "/weird/place/libexec", "darwin"), null);
  });
});

describe("prepareRelaunch: the label comes from the running job, not a constant", () => {
  const ROOT = "/usr/local/stage-utility/current";
  const nothingLoaded = (): boolean => false;

  it("a box launchd started under the NEW label kicks the new label", () => {
    const r = prepareRelaunch("tarball", ROOT, "darwin", { XPC_SERVICE_NAME: DAEMON_LABEL }, nothingLoaded);
    assert.equal(r.job, DAEMON_LABEL);
    const script = r.plan!.args.join(" ");
    assert.ok(script.includes(`/${DAEMON_LABEL}"`));
    assert.ok(!script.includes(LEGACY_DAEMON_LABELS[0]));
    assert.equal(r.failure, null);
  });

  it("a pre-rename box, still under the LEGACY label, kicks the legacy label", () => {
    // The in-app update never rewrites the plist, so this is what every Mac
    // installed before the rename looks like after upgrading to this code.
    const r = prepareRelaunch("tarball", ROOT, "darwin", { XPC_SERVICE_NAME: LEGACY_DAEMON_LABELS[0] }, nothingLoaded);
    assert.equal(r.job, LEGACY_DAEMON_LABELS[0]);
    const script = r.plan!.args.join(" ");
    assert.ok(script.includes(`/${LEGACY_DAEMON_LABELS[0]}"`));
    assert.ok(!script.includes(DAEMON_LABEL));
  });

  it("no usable environment: probes launchd and finds the legacy job", () => {
    const r = prepareRelaunch("tarball", ROOT, "darwin", { XPC_SERVICE_NAME: "0" }, (l) => l === LEGACY_DAEMON_LABELS[0]);
    assert.equal(r.job, LEGACY_DAEMON_LABELS[0]);
    assert.equal(r.failure, null);
  });

  it("no known job anywhere: plans nothing and SAYS why", () => {
    const r = prepareRelaunch("tarball", ROOT, "darwin", { XPC_SERVICE_NAME: "0" }, nothingLoaded);
    assert.equal(r.plan, null);
    assert.equal(r.job, null);
    assert.match(r.failure ?? "", /no known launchd job/);
  });

  it("an install that is not a launchd tarball neither probes nor reports a failure", () => {
    let probed = false;
    const probe = (): boolean => ((probed = true), false);
    for (const [kind, platform] of [
      ["tarball", "linux"],
      ["checkout", "darwin"],
    ] as const) {
      const r = prepareRelaunch(kind === "checkout" ? "git" : kind, ROOT, platform, {}, probe);
      assert.equal(r.plan, null);
      assert.equal(r.failure, null);
    }
    assert.equal(probed, false);
  });

  it("a Homebrew install keeps its own label whatever the environment says", () => {
    const r = prepareRelaunch("homebrew", BETA_KEG, "darwin", { XPC_SERVICE_NAME: DAEMON_LABEL }, nothingLoaded);
    assert.equal(r.job, `homebrew.mxcl.${FORMULA.beta}`);
  });
});
