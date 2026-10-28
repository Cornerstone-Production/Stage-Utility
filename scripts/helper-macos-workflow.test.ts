// The Mac output helper's CI workflow (.github/workflows/helper-macos.yml).
//
// It has to run for every pull request that touches the helper and build and test
// the Swift package there, on a Mac new enough for swift-testing. A gate job on Ubuntu
// decides whether it does, from the files the change touched, which the shared
// changed-files action lists (.github/actions/changed-files); the Mac job is skipped,
// not queued, when the change leaves the helper alone. The gate's own shell is run
// here after the action's, with a stand-in for `gh`, for each path the workflow used
// to filter on, for an unrelated one, and for the release pull request (beta into
// main), where a push is judged by the files that push changed. The workflow is
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

import { type Entry, type Event, RELEASE_PUSH, listChanged } from "./changed-files-test-helpers.js";

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
  name?: string;
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps?: Step[];
}
interface Action {
  runs: { using?: string; steps?: (Step & { shell?: string })[] };
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
const doc = parse(fs.readFileSync(WORKFLOW, "utf8")) as Workflow;
const job = doc.jobs["swift"];
const gateJob = doc.jobs["gate"];
const LOCAL = SELECT_XCODE.replace("select-xcode", "changed-files");
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
  it("is triggered by every pull request and by hand, nothing else; the gate job decides which touch the helper", () => {
    assert.deepEqual(Object.keys(doc.on).sort(), ["pull_request", "workflow_dispatch"]);
    // A workflow-level paths filter judges the whole pull request, which for the release pull request always holds the helper.
    assert.equal(doc.on["pull_request"], null);
  });

  it("reads the repository and nothing else, the gate adding only the pull request", () => {
    assert.deepEqual(doc.permissions, { contents: "read" });
    assert.deepEqual(gateJob.permissions, { contents: "read", "pull-requests": "read" });
  });

  it("has a gate on Ubuntu and a build on macOS 14 or later, with bounded runs", () => {
    assert.deepEqual(Object.keys(doc.jobs), ["gate", "swift"]);
    assert.equal(gateJob["runs-on"], "ubuntu-latest");
    assert.ok(typeof gateJob["timeout-minutes"] === "number" && gateJob["timeout-minutes"] <= 10);
    const runsOn = /^macos-(\d+)$/.exec(String(job["runs-on"]));
    assert.ok(runsOn, `runs-on is ${String(job["runs-on"])}`);
    assert.ok(Number(runsOn[1]) >= 14, "the helper needs macOS 14 or later");
    assert.ok(typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] <= 60, "an unbounded macOS job");
  });

  it("builds when the gate says so, when the gate did not succeed, and always on a manual run", () => {
    assert.equal(job.needs, "gate");
    // A gate that failed or was cancelled by an error runs the build rather than skipping it.
    assert.equal(
      job.if,
      "${{ !cancelled() && (github.event_name == 'workflow_dispatch' || needs.gate.result != 'success' || needs.gate.outputs.run == 'true') }}",
    );
    // The gate has nothing to list on a manual run, so it does not run there.
    assert.equal(gateJob.if, "${{ github.event_name == 'pull_request' }}");
    assert.deepEqual(gateJob.outputs, { run: "${{ steps.gate.outputs.run }}" });
  });

  it("names its jobs without an expression, because a skipped job shows its name unevaluated", () => {
    for (const j of Object.values(doc.jobs)) assert.doesNotMatch(String(j.name), /\$\{\{/);
  });

  it("lists the files with the shared action, from a sparse checkout, before the gate reads them", () => {
    const steps = gateJob.steps ?? [];
    assert.deepEqual(
      steps.map((s) => (s as { id?: string }).id ?? s.uses?.replace(/@.*/, "")),
      ["actions/checkout", "files", "gate"],
    );
    assert.deepEqual(steps[0].with, { "sparse-checkout": ".github/actions", "persist-credentials": false });
    assert.equal(steps[1].uses, LOCAL);
    assert.deepEqual(steps[1].with, { token: "${{ github.token }}" });
    assert.deepEqual((steps[2] as { env?: unknown }).env, { ALL: "${{ steps.files.outputs.all }}", FILES: "${{ steps.files.outputs.file }}" });
  });

  it("pins every action to a commit, the one in this repository excepted", () => {
    const uses = [...(gateJob.steps ?? []), ...(job.steps ?? [])].flatMap((s) =>
      s.uses && s.uses !== SELECT_XCODE && s.uses !== LOCAL ? [s.uses] : [],
    );
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  });
});

describe("the gate runs the Mac build for the helper's paths and for nothing else", () => {
  const gate = (gateJob.steps ?? []).find((s) => (s as { id?: string }).id === "gate");

  /** The changed-files action's own shell, then the gate's own shell on what it wrote. */
  function decide(c: Omit<Event, "via"> & { via?: Event["via"] }): { run: boolean; calls: string[]; log: string } {
    assert.ok(gate?.run, "no gate step");
    const listed = listChanged({ via: c.event === "pull_request" ? "pr" : "none", ...c });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "su-helper-gate-"));
    try {
      const out = path.join(tmp, "output");
      const file = path.join(tmp, "files.txt");
      fs.writeFileSync(out, "");
      fs.writeFileSync(file, listed.files.map((f) => `${f}\n`).join(""));
      // Actions runs a `run:` step with no `shell:` as `bash -e {0}`.
      const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", gate.run], {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "", GITHUB_OUTPUT: out, ALL: String(listed.all), FILES: file },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(/^run=(true|false)\n$/.test(fs.readFileSync(out, "utf8")), fs.readFileSync(out, "utf8"));
      return { run: fs.readFileSync(out, "utf8") === "run=true\n", calls: listed.calls, log: listed.log + r.stdout };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const pr = (...files: Entry[]) => decide({ event: "pull_request", files });

  // The workflow's own paths filter, until the gate replaced it.
  const RUNS = [
    "helper/macos/Package.swift",
    "helper/macos/Sources/DeckLinkKit/CardSink.swift",
    "helper/README.md",
    "scripts/kiosk/install-macos.sh",
    ".github/workflows/helper-macos.yml",
    ".github/actions/select-xcode/action.yml",
  ];
  const SKIPS = [
    "main/server.ts",
    "docs/contributing.md",
    "package.json",
    "scripts/kiosk/install-windows.sh",
    "scripts/kiosk/install-macos.sh.bak",
    "helper-notes.md",
    "docs/helper/macos/x.md",
    ".github/workflows/ci.yml",
    ".github/workflows/helper-macos.yml.bak",
    ".github/actions/changed-files/action.yml",
    ".github/actions/select-xcode-notes.md",
  ];

  it("runs for a pull request that touches each path the helper's tests read", () => {
    for (const f of RUNS) assert.equal(pr("docs/a.md", f).run, true, f);
  });

  it("skips for a pull request that touches none of them, look-alikes included", () => {
    assert.deepEqual(pr(...SKIPS).run, false);
    for (const f of SKIPS) assert.equal(pr(f).run, false, f);
  });

  it("counts the path a renamed file came from", () => {
    assert.equal(pr({ filename: "docs/Moved.swift", previous_filename: "helper/macos/Sources/Moved.swift" }).run, true);
  });

  describe("on the release pull request, beta into main", () => {
    const compare = [`repos/o/r/compare/${"1".repeat(40)}...${"2".repeat(40)}`];
    const whole = ["repos/o/r/pulls/1/files"];

    it("runs for a push that changed a helper path, and skips for one that did not", () => {
      for (const f of RUNS) {
        const r = decide({ ...RELEASE_PUSH, via: "compare", files: ["docs/a.md", f] });
        assert.equal(r.run, true, f);
        assert.deepEqual(r.calls, compare, f);
      }
      const r = decide({ ...RELEASE_PUSH, via: "compare", files: SKIPS });
      assert.equal(r.run, false);
      // The comparison, never the pull request's own files, which always hold the helper.
      assert.deepEqual(r.calls, compare);
    });

    it("lists the whole pull request when it is opened or reopened", () => {
      for (const action of ["opened", "reopened"]) {
        const r = decide({ ...RELEASE_PUSH, action, via: "pr", files: ["docs/a.md", "helper/macos/Package.swift"] });
        assert.equal(r.run, true, action);
        assert.deepEqual(r.calls, whole, action);
        assert.equal(decide({ ...RELEASE_PUSH, action, via: "pr", files: SKIPS }).run, false, action);
      }
    });

    it("lists the whole pull request for any other branch, and for a fork's branch named beta", () => {
      for (const head of [{ headRef: "feature/x", headRepo: "o/r" }, { headRef: "beta", headRepo: "someone/r" }, { headRef: "beta", headRepo: "" }]) {
        const r = decide({ ...RELEASE_PUSH, ...head, via: "pr", files: ["docs/a.md", "helper/macos/Package.swift"] });
        assert.equal(r.run, true, JSON.stringify(head));
        assert.deepEqual(r.calls, whole, JSON.stringify(head));
      }
    });

    it("lists the whole pull request when the event has no real previous commit", () => {
      for (const before of ["", "0".repeat(40)]) {
        const r = decide({ ...RELEASE_PUSH, before, via: "pr", files: ["docs/a.md"] });
        assert.deepEqual(r.calls, whole, JSON.stringify(before));
        assert.equal(r.run, false, JSON.stringify(before));
      }
    });
  });

  it("runs, and says why, when the files cannot be listed, none are listed, or the listing may be cut off", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `docs/page-${i}.md`);
    const cases: [string, Parameters<typeof decide>[0], RegExp][] = [
      ["pull request, API failure", { event: "pull_request", files: "error" }, /could not list the pull request's files/],
      ["pull request, empty", { event: "pull_request", files: [] }, /no files listed/],
      ["pull request, 3000 files", { event: "pull_request", files: many(3000) }, /file list may be truncated/],
      ["release push, API failure", { ...RELEASE_PUSH, via: "compare", files: "error" }, /could not compare the push to the release pull request/],
      ["release push, empty", { ...RELEASE_PUSH, via: "compare", files: [] }, /no files listed/],
      ["release push, 300 files", { ...RELEASE_PUSH, via: "compare", files: many(300) }, /file list may be truncated/],
    ];
    for (const [name, c, why] of cases) {
      const r = decide(c);
      assert.equal(r.run, true, name);
      assert.match(r.log, why, name);
    }
    assert.equal(decide({ event: "pull_request", files: many(2999) }).run, false);
    assert.equal(decide({ ...RELEASE_PUSH, via: "compare", files: many(299) }).run, false);
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
