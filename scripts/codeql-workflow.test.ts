// The CodeQL workflows (.github/workflows/codeql.yml and codeql-language.yml).
//
// Every language but JavaScript/TypeScript is skipped for a change that touches
// nothing it analyses: Swift and C/C++ for anything outside helper/macos, Ruby for
// anything but a .rb file, the workflows for anything outside .github. A skipped
// language still hands code scanning an empty result on a pull request, so the
// "CodeQL" check finds every configuration the base branch has, and never on a push,
// where it would close that language's alerts. The workflows are parsed, not
// searched, and the gate's own shell and the empty result's own shell are run, so a
// gate that skips a helper change, runs for an unrelated one, or fails closed on an
// API error goes red, and so does an empty result that is not valid or is uploaded
// on a push. The `gh` stand-in answers like the API: it checks the endpoint, serves a
// page of 30 unless the call paginates, caps the comparison at 300 files, and runs the
// real `jq` on the call's own filter, so a call that asks for the wrong thing fails.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(HERE, "..", ".github", "workflows");

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Job {
  name?: string;
  needs?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
const load = (name: string) => parse(fs.readFileSync(path.join(WORKFLOWS, name), "utf8")) as Workflow;
const caller = load("codeql.yml");
const language = load("codeql-language.yml");

const LANGUAGES = ["swift", "c-cpp", "ruby", "actions"] as const;
const REUSABLE = "./.github/workflows/codeql-language.yml";
const gate = caller.jobs["changes"].steps?.find((s) => s.id === "gate");
const analyze = language.jobs["analyze"];
const emptyResult = language.jobs["empty-result"];

describe("codeql.yml's shape", () => {
  it("runs on pull requests and pushes to beta and main, weekly, and by hand", () => {
    assert.deepEqual(Object.keys(caller.on).sort(), ["pull_request", "push", "schedule", "workflow_dispatch"]);
    assert.deepEqual(caller.on["pull_request"], { branches: ["beta", "main"] });
    assert.deepEqual(caller.on["push"], { branches: ["beta", "main"] });
  });

  it("reads the repository by default, and only the jobs that analyse can write findings", () => {
    assert.deepEqual(caller.permissions, { contents: "read" });
    assert.deepEqual(caller.jobs["changes"].permissions, { contents: "read", "pull-requests": "read" });
    for (const [id, job] of Object.entries(caller.jobs))
      if (id !== "changes") assert.deepEqual(job.permissions, { contents: "read", "security-events": "write" }, id);
  });

  it("lets a newer push replace an older pull request run, and gives every other run a group of its own", () => {
    // A pending run is replaced by a newer one in its group; the replaced push may be the one that changed Swift.
    const c = (caller as unknown as { concurrency: { group: string; "cancel-in-progress": string } }).concurrency;
    assert.equal(c.group, "codeql-${{ github.event.pull_request.number || github.run_id }}");
    assert.equal(c["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  });

  it("has one job per language, each calling the one workflow that does the analysis", () => {
    assert.deepEqual(Object.keys(caller.jobs).sort(), ["actions", "c-cpp", "changes", "javascript-typescript", "ruby", "swift"]);
    for (const [id, job] of Object.entries(caller.jobs))
      if (id !== "changes") {
        assert.equal(job.uses, REUSABLE, id);
        assert.equal(job.with?.["language"], id, id);
      }
  });
});

describe("which languages are gated", () => {
  it("gates every language but JavaScript/TypeScript on the gate's answer for that language", () => {
    for (const l of LANGUAGES) {
      assert.equal(caller.jobs[l].needs, "changes", l);
      // A failed or cancelled-by-error gate runs the language rather than skipping it.
      assert.equal(caller.jobs[l].if, "${{ !cancelled() }}", l);
      assert.equal(
        caller.jobs[l].with?.["run"],
        `\${{ needs.changes.result != 'success' || needs.changes.outputs.${l} == 'true' }}`,
        l,
      );
      assert.equal(caller.jobs["changes"].outputs?.[l], `\${{ steps.gate.outputs.${l} }}`, l);
    }
  });

  it("never gates JavaScript/TypeScript", () => {
    const job = caller.jobs["javascript-typescript"];
    assert.equal(job.with?.["run"], true);
    assert.equal(job.needs, undefined);
  });

  it("analyses Swift on macOS and the others on Ubuntu, building only Swift", () => {
    assert.match(String(caller.jobs["swift"].with?.["runner"]), /^macos-/);
    assert.equal(caller.jobs["swift"].with?.["build-mode"], "autobuild");
    for (const id of ["c-cpp", "ruby", "actions", "javascript-typescript"]) {
      assert.equal(caller.jobs[id].with?.["runner"], undefined, id);
      assert.equal(caller.jobs[id].with?.["build-mode"], undefined, id);
    }
    const inputs = (language.on["workflow_call"] as { inputs: Record<string, { default?: string }> }).inputs;
    assert.equal(inputs["runner"].default, "ubuntu-latest");
    assert.equal(inputs["build-mode"].default, "none");
  });
});

describe("the per-language workflow", () => {
  it("pins every action to a commit, in both workflows", () => {
    for (const w of [caller, language])
      for (const j of Object.values(w.jobs))
        for (const s of j.steps ?? []) if (s.uses) assert.match(s.uses, /@[0-9a-f]{40}( #.*)?$/, s.uses);
  });

  it("analyses only when asked to, on the runner it is given, with a bounded run", () => {
    assert.equal(analyze.if, "${{ inputs.run }}");
    assert.equal(analyze["runs-on"], "${{ inputs.runner }}");
    assert.ok(typeof analyze["timeout-minutes"] === "number" && analyze["timeout-minutes"] <= 60);
    assert.equal(analyze.name, "Analyze (${{ inputs.language }})");
  });

  it("initialises CodeQL for the language and build mode it is given, with the extended queries", () => {
    const init = analyze.steps?.find((s) => s.uses?.startsWith("github/codeql-action/init@"));
    assert.equal(init?.with?.["languages"], "${{ inputs.language }}");
    assert.equal(init?.with?.["build-mode"], "${{ inputs.build-mode }}");
    assert.equal(init?.with?.["queries"], "security-extended");
  });

  it("uploads an empty result only for a skipped language on a pull request, never on a push", () => {
    // A push upload of "no results" closes the alerts the branch has for the language.
    assert.equal(emptyResult.if, "${{ !inputs.run && github.event_name == 'pull_request' }}");
    assert.equal(emptyResult["runs-on"], "ubuntu-latest");
  });

  it("files the analysis and the empty result under the same category", () => {
    const category = (j: Job) =>
      j.steps?.find((s) => s.uses?.startsWith("github/codeql-action/analyze@") || s.uses?.startsWith("github/codeql-action/upload-sarif@"))?.with?.["category"];
    assert.equal(category(analyze), "/language:${{ inputs.language }}");
    assert.equal(category(emptyResult), category(analyze));
  });

  it("writes a SARIF file that names CodeQL and holds one run with no results", () => {
    const step = emptyResult.steps?.find((s) => s.run?.includes("empty.sarif"));
    assert.ok(step?.run, "no step writes the empty result");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "su-codeql-sarif-"));
    try {
      const r = spawnSync("bash", ["-c", step.run], { cwd: tmp, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const sarif = JSON.parse(fs.readFileSync(path.join(tmp, "empty.sarif"), "utf8")) as {
        version: string;
        runs: { tool: { driver: { name: string } }; results: unknown[] }[];
      };
      assert.equal(sarif.version, "2.1.0");
      assert.equal(sarif.runs.length, 1);
      assert.equal(sarif.runs[0].tool.driver.name, "CodeQL");
      assert.deepEqual(sarif.runs[0].results, []);
      const upload = emptyResult.steps?.find((s) => s.uses?.startsWith("github/codeql-action/upload-sarif@"));
      assert.equal(upload?.with?.["sarif_file"], "empty.sarif");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** `gh api [--paginate] <endpoint> --jq <filter>`, answering as the REST API does. */
const GH = `#!/bin/bash
paginate=0; endpoint=""; filter=""
while [ $# -gt 0 ]; do
  case "$1" in
    api) ;;
    --paginate) paginate=1 ;;
    --jq) filter="$2"; shift ;;
    *) endpoint="$1" ;;
  esac
  shift
done
[ -n "$GH_FAIL" ] && { echo "api failure" >&2; exit 1; }
[ "$endpoint" = "$GH_EXPECT" ] || { echo "unexpected endpoint $endpoint, wanted $GH_EXPECT" >&2; exit 1; }
case "$endpoint" in
  */pulls/*/files)
    # 30 a page, 3000 in all; only a paginating call sees past the first page.
    if [ "$paginate" = 1 ]; then jq 'limit(3000; .[])' "$GH_FIXTURE" | jq -s '.' | jq -r "$filter"
    else jq 'limit(30; .[])' "$GH_FIXTURE" | jq -s '.' | jq -r "$filter"; fi ;;
  */compare/*)
    # 300 files at most, and an object rather than an array.
    jq '{files: .[0:300]}' "$GH_FIXTURE" | jq -r "$filter" ;;
esac
`;

describe("the gate decides which languages run", () => {
  type Entry = string | { filename: string; previous_filename: string };
  interface Case {
    event: string;
    ref?: string;
    before?: string;
    files?: Entry[] | "error";
  }
  type Flags = Record<(typeof LANGUAGES)[number], boolean>;
  const all = (v: boolean): Flags => ({ swift: v, "c-cpp": v, ruby: v, actions: v });

  function decide(c: Case): { flags: Flags; log: string } {
    assert.ok(gate?.run, "no gate step");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "su-codeql-gate-"));
    const out = path.join(tmp, "output");
    try {
      const before = c.before ?? "1".repeat(40);
      const sha = "2".repeat(40);
      const endpoint = c.event === "pull_request" ? "repos/o/r/pulls/1/files" : `repos/o/r/compare/${before}...${sha}`;
      const fixture = path.join(tmp, "files.json");
      fs.writeFileSync(
        fixture,
        JSON.stringify(Array.isArray(c.files) ? c.files.map((f) => (typeof f === "string" ? { filename: f } : f)) : []),
      );
      fs.writeFileSync(path.join(tmp, "gh"), GH, { mode: 0o755 });
      fs.writeFileSync(out, "");
      // Actions runs a `run:` step with no `shell:` as `bash -e {0}`.
      const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", gate.run as string], {
        encoding: "utf8",
        env: {
          PATH: `${tmp}:${process.env["PATH"] ?? ""}`,
          GITHUB_OUTPUT: out,
          GH_FIXTURE: fixture,
          GH_FAIL: c.files === "error" ? "1" : "",
          GH_EXPECT: endpoint,
          EVENT: c.event,
          REF: c.ref ?? "refs/heads/beta",
          REPO: "o/r",
          PR_NUMBER: "1",
          BEFORE: before,
          SHA: sha,
        },
      });
      assert.equal(r.status, 0, r.stderr);
      const lines = fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, LANGUAGES.length, `one output per language, got ${lines.join(", ")}`);
      const flags = Object.fromEntries(lines.map((l) => l.split("=") as [string, string]).map(([k, v]) => [k, v === "true"]));
      return { flags: flags as Flags, log: r.stdout };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const pr = (...files: Entry[]) => decide({ event: "pull_request", files }).flags;

  it("skips every gated language for a pull request that changes only TypeScript and docs", () => {
    assert.deepEqual(pr("main/server.ts", "renderer/App.tsx", "docs/contributing.md", "package.json"), all(false));
  });

  it("runs Swift and C/C++, and nothing else, for a change under helper/macos", () => {
    assert.deepEqual(pr("main/server.ts", "helper/macos/Sources/DeckLinkKit/CardSink.swift"), { ...all(false), swift: true, "c-cpp": true });
    assert.deepEqual(pr("helper/macos/CEFHost/cef_host_mac.mm"), { ...all(false), swift: true, "c-cpp": true });
  });

  it("runs Ruby, and nothing else, for a .rb file anywhere", () => {
    assert.deepEqual(pr("packaging/homebrew/stage-utility.rb"), { ...all(false), ruby: true });
    assert.deepEqual(pr("a/b/c/thing.rb"), { ...all(false), ruby: true });
  });

  it("runs the workflows' analysis, and nothing else, for a change under .github", () => {
    assert.deepEqual(pr(".github/workflows/ci.yml"), { ...all(false), actions: true });
    assert.deepEqual(pr(".github/actions/select-xcode/action.yml"), { ...all(false), actions: true });
    assert.deepEqual(pr(".github/dependabot.yml"), { ...all(false), actions: true });
  });

  it("runs every language for a change to either CodeQL workflow", () => {
    assert.deepEqual(pr(".github/workflows/codeql.yml"), all(true));
    assert.deepEqual(pr("main/server.ts", ".github/workflows/codeql-language.yml"), all(true));
  });

  it("is not fooled by a look-alike path", () => {
    // A backup of the workflow is .github, so the workflows' analysis, but not every language.
    assert.deepEqual(pr(".github/workflows/codeql.yml.bak"), { ...all(false), actions: true });
    const flags = pr(
      "helper/macos-notes.md",
      "docs/helper/macos/x.md",
      "docs/github/workflows.md",
      "rb",
      "Gemfile.rbs",
    );
    assert.deepEqual(flags, all(false));
  });

  it("gates a push to beta the same way", () => {
    assert.deepEqual(decide({ event: "push", files: ["main/server.ts"] }).flags, all(false));
    assert.deepEqual(decide({ event: "push", files: ["helper/macos/Package.swift"] }).flags, { ...all(false), swift: true, "c-cpp": true });
  });

  it("runs every language for a push to main, the release, whatever it changed", () => {
    assert.deepEqual(decide({ event: "push", ref: "refs/heads/main", files: ["main/server.ts"] }).flags, all(true));
  });

  it("runs every language on the schedule and by hand", () => {
    assert.deepEqual(decide({ event: "schedule", files: ["main/server.ts"] }).flags, all(true));
    assert.deepEqual(decide({ event: "workflow_dispatch", files: ["main/server.ts"] }).flags, all(true));
  });

  it("runs every language for the first push of a branch, which has nothing to compare with", () => {
    assert.deepEqual(decide({ event: "push", before: "0".repeat(40), files: ["main/server.ts"] }).flags, all(true));
  });

  it("runs every language, and says why, when the files cannot be listed", () => {
    for (const event of ["pull_request", "push"]) {
      const r = decide({ event, files: "error" });
      assert.deepEqual(r.flags, all(true), event);
      assert.match(r.log, /could not/, event);
    }
  });

  it("runs every language when the listing is as long as the API's limit, since it may be cut off", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `docs/page-${i}.md`);
    assert.deepEqual(decide({ event: "pull_request", files: many(3000) }).flags, all(true));
    assert.deepEqual(decide({ event: "push", files: many(300) }).flags, all(true));
    assert.deepEqual(decide({ event: "pull_request", files: many(2999) }).flags, all(false));
    assert.deepEqual(decide({ event: "push", files: many(299) }).flags, all(false));
  });

  it("runs every language for an empty listing, which is a listing not yet ready", () => {
    for (const event of ["pull_request", "push"]) assert.deepEqual(decide({ event, files: [] }).flags, all(true), event);
  });

  it("counts the path a renamed file came from, so moving Swift out of the helper runs it", () => {
    assert.deepEqual(pr("docs/a.md", { filename: "docs/Moved.swift", previous_filename: "helper/macos/Sources/Moved.swift" } ), {
      ...all(false),
      swift: true,
      "c-cpp": true,
    });
    assert.deepEqual(decide({ event: "push", files: [{ filename: "x/a.rb", previous_filename: "docs/old.md" }] }).flags, { ...all(false), ruby: true });
  });

  it("sees a helper file past the first page of a long pull request", () => {
    // Without --paginate the API answers the first 30 files only.
    const files = [...Array.from({ length: 40 }, (_, i) => `docs/page-${i}.md`), "helper/macos/Package.swift"];
    assert.deepEqual(pr(...files), { ...all(false), swift: true, "c-cpp": true });
  });

  it("finds a helper file in a listing too long for a pipe to carry in one write", () => {
    // `printf | grep -q` under pipefail reports a miss when grep exits on the first
    // match before printf finishes writing: 141, which is a failed `if`.
    const long = ["helper/macos/Package.swift", ...Array.from({ length: 2900 }, (_, i) => `docs/${"x".repeat(60)}-${i}.md`)];
    assert.deepEqual(decide({ event: "pull_request", files: long }).flags, { ...all(false), swift: true, "c-cpp": true });
  });
});
