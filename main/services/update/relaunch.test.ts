import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareRelaunch, scheduleRelaunch, type RelaunchDeps } from "./relaunch.js";
import { DAEMON_LABEL, KNOWN_DAEMON_LABELS, LEGACY_DAEMON_LABELS, type DaemonLabel, type LabelProbe } from "./launchd-label.js";
import type { InstallKind } from "./install-kind.js";
import type { SpawnPlan } from "./strategy.js";
import { FORMULA } from "./homebrew-strategy.js";

// The regression this guards: "restart" meant exit(0) and let the service
// manager relaunch us — but launchd PARKS nondemand spawns ("pended nondemand
// spawn = inefficient"), so a Homebrew box that restarted for a config restore
// simply never came back. Observed live 2026-08-13.

const BETA_KEG = `/opt/homebrew/Cellar/${FORMULA.beta}/1.10.0-beta.28/libexec`;
const MAIN_KEG = `/opt/homebrew/Cellar/${FORMULA.main}/1.9.5/libexec`;

/**
 * The plan prepareRelaunch makes for an install whose launchd job is `label`, or
 * for a macOS tarball install where no job can be found when `label` is null.
 * The label reaches prepareRelaunch the way production gives it one: in
 * XPC_SERVICE_NAME, with launchd otherwise reporting nothing loaded.
 */
function planFor(kind: InstallKind, appRoot: string, platform: NodeJS.Platform, label: DaemonLabel | null): SpawnPlan | null {
  const env = { XPC_SERVICE_NAME: label ?? "0" };
  return prepareRelaunch(kind, appRoot, platform, env, () => "not-loaded").plan;
}

describe("the plan prepareRelaunch makes", () => {
  it("kickstarts the beta formula's label on a Homebrew beta install", () => {
    const p = planFor("homebrew", BETA_KEG, "darwin", null);
    assert.ok(p, "must plan a relaunch on launchd");
    // Every kick target, extracted — not substring absence, which "-beta"
    // containing "stage-utility" would satisfy under any quoting change.
    const targets = [...p.args.join(" ").matchAll(/-p "[^"]*\/([^"]+)"/g)].map((m) => m[1]);
    assert.equal(targets.length, 2, "exactly the gui and system domains");
    for (const t of targets) assert.equal(t, `homebrew.mxcl.${FORMULA.beta}`);
  });

  it("matches the formula on a path segment, so main cannot win inside the beta keg's name", () => {
    const p = planFor("homebrew", MAIN_KEG, "darwin", null);
    assert.ok(p!.args.join(" ").includes(`homebrew.mxcl.${FORMULA.main}`));
  });

  it("kickstarts whichever daemon label the caller resolved on a macOS tarball install", () => {
    for (const label of KNOWN_DAEMON_LABELS) {
      const p = planFor("tarball", "/usr/local/stage-utility/current", "darwin", label);
      const targets = [...p!.args.join(" ").matchAll(/-p "[^"]*\/([^"]+)"/g)].map((m) => m[1]);
      assert.equal(targets.length, 2, "exactly the gui and system domains");
      for (const t of targets) assert.equal(t, label);
    }
  });

  it("a macOS tarball install with no resolved label plans nothing rather than kicking a guess", () => {
    assert.equal(planFor("tarball", "/usr/local/stage-utility/current", "darwin", null), null);
  });

  it("demands the spawn WITHOUT killing: -p only, both domains, never fatal", () => {
    // -p is "start if not running": if KeepAlive already relaunched the server
    // (a box where launchd did not park it), the healthy successor is left
    // alone. -k here would kill it mid-boot and start a third instance.
    const s = planFor("homebrew", BETA_KEG, "darwin", null)!.args.join(" ");
    assert.match(s, /kickstart -p "gui\/\$\(id -u\)\//, "gui domain for brew services as a user");
    assert.match(s, /kickstart -p "system\//, "system domain for a root daemon");
    assert.ok(!s.includes("-k"), "must not kill a successor KeepAlive already started");
    assert.ok(s.trimEnd().endsWith("|| true"), "a failed kickstart must not become a crash");
  });

  it("sleeps past our own exit before kicking", () => {
    const script = planFor("tarball", "/usr/local/stage-utility/current", "darwin", DAEMON_LABEL)!.args.at(-1)!;
    assert.match(script, /^sleep [0-9]/);
  });

  it("plans nothing where the service manager already relaunches reliably", () => {
    // systemd has Restart=always; Task Scheduler has RestartCount.
    //
    // Every case is handed a RESOLVED label and a recognisable install, so the
    // only thing that can make it null is the platform / kind itself. Without
    // the label the tarball cases returned null for want of one, and deleting
    // the platform check left this green.
    assert.equal(planFor("tarball", "/opt/stage-utility/current", "linux", DAEMON_LABEL), null);
    assert.equal(planFor("tarball", "C:\\Program Files\\Stage Utility\\current", "win32", DAEMON_LABEL), null);
    assert.equal(planFor("homebrew", BETA_KEG, "linux", DAEMON_LABEL), null);
    assert.equal(planFor("git", "/Users/x/stage-utility", "darwin", DAEMON_LABEL), null);
    assert.equal(planFor("unknown", "/somewhere", "darwin", DAEMON_LABEL), null);
  });

  it("an unrecognisable keg path plans nothing rather than kicking a guessed label", () => {
    assert.equal(planFor("homebrew", "/weird/place/libexec", "darwin", null), null);
  });
});

describe("prepareRelaunch: the label comes from the running job, not a constant", () => {
  const ROOT = "/usr/local/stage-utility/current";
  const nothingLoaded: LabelProbe = () => "not-loaded";

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
    const r = prepareRelaunch("tarball", ROOT, "darwin", { XPC_SERVICE_NAME: "0" }, (l) => (l === LEGACY_DAEMON_LABELS[0] ? "loaded" : "not-loaded"));
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
    const probe: LabelProbe = () => ((probed = true), "not-loaded");
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

describe("scheduleRelaunch: the real exit path, with launchd and the spawn faked", () => {
  const ROOT = "/usr/local/stage-utility/current";

  interface Spawned {
    command: string;
    args: string[];
  }

  /** Runs scheduleRelaunch with fakes and reports what it spawned and logged. */
  function run(over: Partial<RelaunchDeps>) {
    const spawned: Spawned[] = [];
    let unrefs = 0;
    const logs: string[] = [];
    const errors: string[] = [];
    const prep = scheduleRelaunch({
      kind: "tarball",
      appRoot: ROOT,
      platform: "darwin",
      env: {},
      probe: () => "not-loaded",
      spawn: (command, args) => {
        spawned.push({ command, args });
        return { unref: () => void unrefs++ };
      },
      log: { log: (m: string) => void logs.push(m), error: (m: string) => void errors.push(m) },
      ...over,
    });
    return { prep, spawned, unrefs, logs, errors };
  }

  it("a pre-rename Mac spawns bash with a script that kicks the LEGACY label", () => {
    const r = run({ env: { XPC_SERVICE_NAME: LEGACY_DAEMON_LABELS[0] } });
    assert.equal(r.spawned.length, 1, "must spawn exactly one helper");
    assert.equal(r.spawned[0].command, "bash");
    const script = r.spawned[0].args.at(-1)!;
    assert.match(script, /^sleep [0-9]/);
    assert.ok(script.includes(`/${LEGACY_DAEMON_LABELS[0]}"`), script);
    assert.ok(!script.includes(DAEMON_LABEL), "must not also kick the new label");
    assert.equal(r.unrefs, 1, "the helper must be detached from our exit");
    assert.equal(r.errors.length, 0);
  });

  it("a Mac on the new label spawns a script that kicks the NEW label", () => {
    const r = run({ env: { XPC_SERVICE_NAME: DAEMON_LABEL } });
    assert.equal(r.spawned.length, 1);
    const script = r.spawned[0].args.at(-1)!;
    assert.ok(script.includes(`/${DAEMON_LABEL}"`), script);
    assert.ok(!script.includes(LEGACY_DAEMON_LABELS[0]));
  });

  it("logs ONE line naming the job it kicks", () => {
    const r = run({ env: { XPC_SERVICE_NAME: DAEMON_LABEL } });
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /^\[relaunch\] /);
    assert.ok(r.logs[0].includes(`job ${DAEMON_LABEL}`), r.logs[0]);
  });

  it("the helper is spawned detached with stdio ignored, so it outlives us", () => {
    let options: unknown;
    run({
      env: { XPC_SERVICE_NAME: DAEMON_LABEL },
      spawn: (_c, _a, o) => ((options = o), { unref: () => {} }),
    });
    assert.equal((options as { detached?: boolean }).detached, true);
    assert.equal((options as { stdio?: string }).stdio, "ignore");
  });

  it("a job it cannot find: logs the failure on [relaunch] and spawns NOTHING", () => {
    const r = run({ env: { XPC_SERVICE_NAME: "0" } });
    assert.equal(r.spawned.length, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^\[relaunch\] cannot kick this server back up/);
    assert.match(r.errors[0], /no known launchd job/);
    assert.equal(r.prep.failure !== null, true, "the caller is told too");
  });

  it("an install that is not a launchd job neither spawns nor complains", () => {
    const r = run({ platform: "linux" });
    assert.equal(r.spawned.length, 0);
    assert.equal(r.errors.length, 0);
    assert.equal(r.logs.length, 0);
    assert.equal(r.prep.failure, null);
  });

  it("a Homebrew install spawns a kick of its own formula's label", () => {
    const r = run({ kind: "homebrew", appRoot: BETA_KEG });
    assert.equal(r.spawned.length, 1);
    assert.ok(r.spawned[0].args.at(-1)!.includes(`homebrew.mxcl.${FORMULA.beta}`));
  });
});
