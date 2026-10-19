// The Mac output helper's CI workflow (.github/workflows/helper-macos.yml).
//
// It has to run for every pull request that touches the helper and build and test
// the Swift package there, on a Mac new enough for swift-testing. The workflow is
// parsed, not searched, and its steps' own shell is run on a temporary tree with
// `swift`, `sudo` and `xcode-select` stood in for, so a step that no longer builds,
// no longer stops on a failed build, or picks an Xcode too old goes red.
//
// The Xcode choice is a local composite action, .github/actions/select-xcode, used
// by this workflow and by the release workflow's helper build, so the binary that
// ships is built with the toolchain this CI tests. The action's own shell is what
// is run here, and both workflows are checked to use it, before their build.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(HERE, "..", ".github", "workflows", "helper-macos.yml");
const RELEASE = path.join(HERE, "..", ".github", "workflows", "release.yml");
const SELECT_XCODE = "$/.github/actions/select-xcode";
const SELECT_XCODE_FILE = path.join(HERE, "..", ".github", "actions", "select-xcode", "action.yml");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps?: Step[];
}
interface Action {
  runs: { using?: string; steps?: (Step & { shell?: string })[] };
}
interface Workflow {
  on: Record<string, { paths?: string[] } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
const doc = parse(fs.readFileSync(WORKFLOW, "utf8")) as Workflow;
const job = doc.jobs["swift"];
const action = parse(fs.readFileSync(SELECT_XCODE_FILE, "utf8")) as Action;
const releaseHelper = (parse(fs.readFileSync(RELEASE, "utf8")) as Workflow).jobs["helper"];

/** Run `script` with bash in `cwd`, `bin` first on the PATH. */
function run(script: string, cwd: string, bin: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
  });
}

/** A temporary directory holding stand-in commands that log what they were asked. */
function stubs(log: string, commands: Record<string, string>): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "su-helper-ci-bin-"));
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nLOG=${JSON.stringify(log)}\n${body}\n`, { mode: 0o755 });
  }
  return bin;
}

describe("the helper's CI workflow runs for every pull request that touches the helper", () => {
  it("is triggered by pull requests on the helper, the installer script its tests read, or this workflow, and by hand, nothing else", () => {
    assert.deepEqual(Object.keys(doc.on).sort(), ["pull_request", "workflow_dispatch"]);
    assert.deepEqual(doc.on.pull_request?.paths, [
      "helper/**",
      "scripts/kiosk/install-macos.sh",
      ".github/workflows/helper-macos.yml",
      ".github/actions/select-xcode/**",
    ]);
  });

  it("reads the repository and nothing else", () => {
    assert.deepEqual(doc.permissions, { contents: "read" });
  });

  it("runs on a macOS 14 or later runner, with a bounded run", () => {
    assert.deepEqual(Object.keys(doc.jobs), ["swift"]);
    const runsOn = /^macos-(\d+)$/.exec(String(job["runs-on"]));
    assert.ok(runsOn, `runs-on is ${String(job["runs-on"])}`);
    assert.ok(Number(runsOn[1]) >= 14, "the helper needs macOS 14 or later");
    assert.ok(typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] <= 60, "an unbounded macOS job");
  });

  it("pins every action to a commit, the one in this repository excepted", () => {
    const uses = (job.steps ?? []).flatMap((s) => (s.uses && s.uses !== SELECT_XCODE ? [s.uses] : []));
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  });
});

describe("the build step builds the package and then runs its tests, in helper/macos", () => {
  const build = (job.steps ?? []).find((s) => s.run?.includes("./test.sh"));

  function runBuild(swiftExit: number): { status: number | null; log: string[]; err: string } {
    assert.ok(build?.run, "no step runs ./test.sh");
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "su-helper-ci-"));
    const log = path.join(tree, "log");
    const bin = stubs(log, { swift: `echo "swift $* in $(basename "$PWD")" >>"$LOG"\nexit ${swiftExit}` });
    try {
      fs.mkdirSync(path.join(tree, "helper", "macos"), { recursive: true });
      fs.writeFileSync(
        path.join(tree, "helper", "macos", "test.sh"),
        `#!/bin/bash\necho "test.sh in $(basename "$PWD")" >>${JSON.stringify(log)}\n`,
        { mode: 0o755 },
      );
      const r = run(build.run, tree, bin);
      return { status: r.status, err: r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }

  it("runs `swift build`, then ./test.sh, both in helper/macos", () => {
    const r = runBuild(0);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.log, ["swift build in macos", "test.sh in macos"]);
  });

  it("stops, failing, when the build fails, without running the tests", () => {
    const r = runBuild(1);
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.log, ["swift build in macos"]);
  });

  it("comes after the Xcode is chosen", () => {
    const steps = job.steps ?? [];
    const select = steps.findIndex((s) => s.uses === SELECT_XCODE);
    assert.ok(select >= 0 && select < steps.indexOf(build as Step));
  });
});

describe("the Xcode step picks the newest Xcode 16 or later, or fails saying why", () => {
  const select = action.runs.steps?.find((s) => s.run?.includes("xcode-select"));

  function runSelect(xcodes: string[]): { status: number | null; out: string; log: string[] } {
    assert.ok(select?.run, "no step selects an Xcode");
    const apps = fs.mkdtempSync(path.join(os.tmpdir(), "su-helper-ci-apps-"));
    const log = path.join(apps, "log");
    const bin = stubs(log, {
      sudo: `"$@"`,
      "xcode-select": `echo "xcode-select $*" >>"$LOG"`,
      swift: `echo "swift $*" >>"$LOG"`,
    });
    try {
      for (const x of xcodes) fs.mkdirSync(path.join(apps, x));
      const r = run(select.run, apps, bin, { XCODE_APPS: apps });
      const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { status: r.status, out: r.stdout, log: lines.map((l) => l.replaceAll(apps, "<apps>")) };
    } finally {
      fs.rmSync(apps, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }

  it("chooses the newest of several, by version, not by name", () => {
    const r = runSelect(["Xcode_15.4.app", "Xcode_16.2.app", "Xcode_16.10.app", "Xcode_16.app", "Xcode.app"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.log, ["xcode-select -s <apps>/Xcode_16.10.app", "swift --version"]);
  });

  it("fails with an error annotation when only older ones are there", () => {
    const r = runSelect(["Xcode_15.0.1.app", "Xcode_15.4.app"]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /::error title=Mac output helper::no Xcode 16 or later/);
    assert.deepEqual(r.log, []);
  });
});

describe("the release build selects the Xcode the CI selects", () => {
  it("is a composite action whose only step is the selection", () => {
    assert.equal(action.runs.using, "composite");
    assert.equal(action.runs.steps?.length, 1);
    assert.equal(action.runs.steps?.[0].shell, "bash");
  });

  it("is the same step, in the same place, in both workflows: after checkout, before the build", () => {
    for (const [name, steps, build] of [
      ["helper-macos.yml", job.steps ?? [], "./test.sh"],
      ["release.yml", releaseHelper.steps ?? [], "build-app.sh"],
    ] as const) {
      const uses = steps.map((s) => s.uses ?? "");
      const checkout = uses.findIndex((u) => u.startsWith("actions/checkout@"));
      const select = uses.indexOf(SELECT_XCODE);
      const built = steps.findIndex((s) => s.run?.includes(build));
      assert.ok(checkout >= 0, `${name} checks out`);
      assert.ok(select > checkout, `${name} selects the Xcode after checkout`);
      assert.ok(built > select, `${name} builds after it selects the Xcode`);
      assert.equal(uses.filter((u) => u === SELECT_XCODE).length, 1, `${name} selects it once`);
    }
  });
});
