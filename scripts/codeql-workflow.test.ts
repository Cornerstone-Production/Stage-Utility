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
//
// The shared configuration (.github/codeql/codeql-config.yml) and the model pack
// (.github/codeql/extensions) are checked here too, against the files they name: an
// ignore pattern that no longer covers a test harness, a pattern that swallows
// product code, and a model whose file or function has been renamed all go red. The
// models' behaviour is tested by CodeQL itself, in .github/codeql/tests.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { parse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(HERE, "..", ".github", "workflows");

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
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
/** Jobs that analyse nothing, so write no findings. */
const NOT_ANALYSIS = ["changes", "models"];
/** What the gate answers for: the gated languages, and the model tests. */
const GATED = [...LANGUAGES, "models"] as const;
const REUSABLE = "$/.github/workflows/codeql-language.yml";
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
      if (!NOT_ANALYSIS.includes(id)) assert.deepEqual(job.permissions, { contents: "read", "security-events": "write" }, id);
    assert.deepEqual(caller.jobs["models"].permissions, { contents: "read" });
  });

  it("lets a newer push replace an older pull request run, and gives every other run a group of its own", () => {
    // A pending run is replaced by a newer one in its group; the replaced push may be the one that changed Swift.
    const c = (caller as unknown as { concurrency: { group: string; "cancel-in-progress": string } }).concurrency;
    assert.equal(c.group, "codeql-${{ github.event.pull_request.number || github.run_id }}");
    assert.equal(c["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  });

  it("has one job per language, each calling the one workflow that does the analysis", () => {
    assert.deepEqual(Object.keys(caller.jobs).sort(), ["actions", "c-cpp", "changes", "javascript-typescript", "models", "ruby", "swift"]);
    for (const [id, job] of Object.entries(caller.jobs))
      if (!NOT_ANALYSIS.includes(id)) {
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
    }
    for (const g of GATED) assert.equal(caller.jobs["changes"].outputs?.[g], `\${{ steps.gate.outputs.${g} }}`, g);
  });

  it("gates the model tests on the gate's answer for them", () => {
    assert.equal(caller.jobs["models"].needs, "changes");
    // A failed gate runs them rather than skipping them, like the languages.
    assert.equal(caller.jobs["models"].if, "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.models == 'true') }}");
  });

  it("never gates JavaScript/TypeScript", () => {
    const job = caller.jobs["javascript-typescript"];
    assert.equal(job.with?.["run"], true);
    assert.equal(job.needs, undefined);
  });

  it("analyses Swift and C/C++ on macOS from a build of our own, and the others on Ubuntu without one", () => {
    for (const id of ["swift", "c-cpp"]) {
      assert.match(String(caller.jobs[id].with?.["runner"]), /^macos-/, id);
      assert.equal(caller.jobs[id].with?.["build-mode"], "manual", id);
    }
    for (const id of ["ruby", "actions", "javascript-typescript"]) {
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
        // A same-repository action ($/.github/...) is this commit's own, so it has nothing to pin.
        for (const s of j.steps ?? []) if (s.uses && !s.uses.startsWith("$/")) assert.match(s.uses, /@[0-9a-f]{40}( #.*)?$/, s.uses);
  });

  it("names its jobs without an expression, because a skipped job shows its name unevaluated", () => {
    assert.equal(analyze.name, "Analyze");
    assert.equal(emptyResult.name, "Empty result");
    for (const j of Object.values(language.jobs)) assert.doesNotMatch(String(j.name), /\$\{\{/);
  });

  it("never leaves credentials in the checkout, in either workflow", () => {
    for (const w of [caller, language])
      for (const [id, j] of Object.entries(w.jobs))
        for (const s of j.steps ?? [])
          if (s.uses?.startsWith("actions/checkout@")) assert.equal(String(s.with?.["persist-credentials"]), "false", id);
  });

  it("analyses only when asked to, on the runner it is given, with a bounded run", () => {
    assert.equal(analyze.if, "${{ inputs.run }}");
    assert.equal(analyze["runs-on"], "${{ inputs.runner }}");
    assert.ok(typeof analyze["timeout-minutes"] === "number" && analyze["timeout-minutes"] <= 60);
  });

  it("initialises CodeQL for the language and build mode it is given, from the shared configuration", () => {
    const init = analyze.steps?.find((s) => s.uses?.startsWith("github/codeql-action/init@"));
    assert.equal(init?.with?.["languages"], "${{ inputs.language }}");
    assert.equal(init?.with?.["build-mode"], "${{ inputs.build-mode }}");
    assert.equal(init?.with?.["config-file"], "./.github/codeql/codeql-config.yml");
    // An input here overrides the configuration's own queries.
    assert.equal(init?.with?.["queries"], undefined);
  });

  it("selects Xcode and builds by hand, before analysing, for a manual build", () => {
    const steps = analyze.steps ?? [];
    const at = (pred: (s: Step) => boolean) => steps.findIndex(pred);
    const select = at((s) => s.uses === "$/.github/actions/select-xcode");
    const init = at((s) => !!s.uses?.startsWith("github/codeql-action/init@"));
    const swift = at((s) => s.run === "swift build");
    const shim = at((s) => s.run === "swift build --target DeckLinkShim");
    const done = at((s) => !!s.uses?.startsWith("github/codeql-action/analyze@"));
    // The tracer watches what runs after init, and the toolchain is chosen before it.
    assert.ok(select >= 0 && select < init, "Xcode is selected before CodeQL initialises");
    assert.ok(init < swift && init < shim && swift < done && shim < done, "the builds run between init and analyze");
    for (const i of [select, swift, shim]) assert.match(String(steps[i].if), /inputs\.build-mode == 'manual'/);
    assert.match(String(steps[swift].if), /inputs\.language == 'swift'/);
    assert.match(String(steps[shim].if), /inputs\.language == 'c-cpp'/);
    for (const i of [swift, shim]) assert.equal(steps[i]["working-directory"], "helper/macos");
  });

  it("builds the target the Swift package really has", () => {
    // `swift build --target X` fails on a package with no X, and only on a macOS runner.
    const pkg = fs.readFileSync(path.join(HERE, "..", "helper", "macos", "Package.swift"), "utf8");
    assert.match(pkg, /\.target\(\s*name: "DeckLinkShim"/);
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
  type Flags = Record<(typeof GATED)[number], boolean>;
  const all = (v: boolean): Flags => ({ swift: v, "c-cpp": v, ruby: v, actions: v, models: v });

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
      assert.equal(lines.length, GATED.length, `one output per gated job, got ${lines.join(", ")}`);
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
    assert.deepEqual(pr(".github/dependabot.yml"), { ...all(false), actions: true });
  });

  it("runs Swift and C/C++ for a change to the Xcode selection their builds share", () => {
    assert.deepEqual(pr(".github/actions/select-xcode/action.yml"), { ...all(false), swift: true, "c-cpp": true, actions: true });
  });

  it("runs the model tests, and the workflows' analysis, for a change to the model pack or its tests", () => {
    assert.deepEqual(pr(".github/codeql/extensions/stage-utility-models/models/log-barriers.model.yml"), { ...all(false), actions: true, models: true });
    assert.deepEqual(pr(".github/codeql/tests/models/LogInjection.expected"), { ...all(false), actions: true, models: true });
  });

  it("runs every language for a change to either CodeQL workflow, or to the configuration they share", () => {
    assert.deepEqual(pr(".github/workflows/codeql.yml"), all(true));
    assert.deepEqual(pr("main/server.ts", ".github/workflows/codeql-language.yml"), all(true));
    assert.deepEqual(pr(".github/codeql/codeql-config.yml"), all(true));
  });

  it("is not fooled by a look-alike path", () => {
    // A backup of the workflow is .github, so the workflows' analysis, but not every language.
    assert.deepEqual(pr(".github/workflows/codeql.yml.bak"), { ...all(false), actions: true });
    assert.deepEqual(pr(".github/codeql/codeql-config.yml.bak"), { ...all(false), actions: true, models: true });
    // Anchored at the root: the same words under docs/ are only docs.
    assert.deepEqual(pr("docs/github/codeql/notes.md", "docs/.github/actions/select-xcode/x.md", "docs/x.github/codeql/y.md"), all(false));
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

const ROOT = path.join(HERE, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .stdout.split("\0")
  .filter(Boolean);

/** A glob as CodeQL's paths-ignore reads it: `**` crosses directories, `*` does not. */
const GLOB: Record<string, string> = { "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*" };
function globToRegExp(glob: string): RegExp {
  // One pass, so the output of one rule is never read by another.
  const body = glob.replace(/\*\*\/|\*\*|\*|[.+^${}()|[\]\\]/g, (m) => GLOB[m] ?? `\\${m}`);
  return new RegExp(`^${body}$`);
}

/** Does `file` declare and export a function called `name`? Parsed, so a comment cannot answer for it. */
function exportsFunction(file: string, name: string): boolean {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.some(
    (st) =>
      ts.isFunctionDeclaration(st) &&
      st.name?.text === name &&
      !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
}

describe("the shared CodeQL configuration", () => {
  const config = parse(read(".github/codeql/codeql-config.yml")) as { queries: { uses: string }[]; "paths-ignore": string[] };
  const ignored = (file: string) => config["paths-ignore"].some((g) => globToRegExp(g).test(file));

  /** A file that exists to run tests, by what it is called or what it imports. */
  const isTestSupport = (file: string) =>
    /\.test\.tsx?$/.test(file) ||
    /-(harness|fixture|test-helpers)\.tsx?$/.test(file) ||
    /^(main\/services\/fixtures|renderer\/test-fixtures|scripts\/docs-screenshots|helper\/macos\/(Tests|Fixtures)|\.github\/codeql\/tests)\//.test(file) ||
    ["renderer/test-dom.ts", "renderer/main/test-render-ctx.ts"].includes(file) ||
    (/\.(ts|tsx|mts)$/.test(file) && /from "node:test"/.test(read(file)));
  const testSupport = new Set(tracked.filter(isTestSupport));

  it("runs the extended suite, which is what the default setup ran", () => {
    assert.deepEqual(config.queries, [{ uses: "security-extended" }]);
  });

  it("ignores exactly these paths", () => {
    // Sorted, one to a line: two changes that each add a path merge without a conflict.
    assert.deepEqual([...config["paths-ignore"]].sort(), [
      "**/*-fixture.ts",
      "**/*-harness.ts",
      "**/*-harness.tsx",
      "**/*-test-helpers.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
      ".github/codeql/tests/**",
      ".vite/**",
      "build/**",
      "helper/macos/.build/**",
      "helper/macos/.cef-build/**",
      "helper/macos/.cef/**",
      "helper/macos/Fixtures/**",
      "helper/macos/Tests/**",
      "helper/macos/Vendor/**",
      "helper/macos/dist/**",
      "main/services/fixtures/**",
      "renderer/main/test-render-ctx.ts",
      "renderer/test-dom.ts",
      "renderer/test-fixtures/**",
      "scripts/docs-screenshots/**",
    ]);
  });

  it("ignores every test, and every file that exists to support one", () => {
    // A harness that wraps console.warn is a second place a real flow lands.
    const missed = [...testSupport].filter((f) => !ignored(f));
    assert.deepEqual(missed, []);
  });

  it("ignores no product code", () => {
    const code = tracked.filter((f) => /^(main|renderer|scripts)\/.*\.(ts|tsx|mts|mjs)$|^server\.ts$/.test(f));
    const swallowed = code.filter((f) => !testSupport.has(f) && ignored(f));
    assert.deepEqual(swallowed, []);
    // Nor the helper's own sources, the C/C++ shim included.
    assert.deepEqual(tracked.filter((f) => /^helper\/macos\/(Sources|CEFHost)\//.test(f) && ignored(f)), []);
  });

  it("lists no pattern that matches nothing, unless a build writes it and .gitignore says so", () => {
    const gitignore = read(".gitignore").split("\n").map((l) => l.replace(/^\//, "").replace(/\/$/, ""));
    for (const g of config["paths-ignore"]) {
      const re = globToRegExp(g);
      if (tracked.some((f) => re.test(f))) continue;
      assert.ok(gitignore.includes(g.replace(/\/\*\*$/, "")), `${g} matches no tracked file, and .gitignore does not list it as generated`);
    }
  });
});

describe("the model pack", () => {
  const PACK = ".github/codeql/extensions/stage-utility-models";
  const pack = parse(read(`${PACK}/codeql-pack.yml`)) as {
    name: string;
    library: boolean;
    extensionTargets: Record<string, string>;
    dataExtensions: string[];
  };
  interface Model {
    addsTo: { pack: string; extensible: string };
    data: string[][];
  }
  const modelFiles = fs.readdirSync(path.join(ROOT, PACK, "models")).filter((f) => f.endsWith(".model.yml")).sort();
  const rows = modelFiles.flatMap((f) =>
    (parse(read(`${PACK}/models/${f}`)) as { extensions: Model[] }).extensions.flatMap((e) =>
      e.data.map((d) => ({ kind: e.addsTo.extensible, pack: e.addsTo.pack, type: d[0], path: d[1], rest: d.slice(2).join(",") })),
    ),
  );

  it("is a library for the JavaScript queries' own library, loading every model file", () => {
    assert.equal(pack.name, "stage-utility/javascript-models");
    assert.equal(pack.library, true);
    assert.deepEqual(pack.extensionTargets, { "codeql/javascript-all": "*" });
    assert.deepEqual(pack.dataExtensions, ["models/*.model.yml"]);
    for (const r of rows) assert.equal(r.pack, "codeql/javascript-all");
  });

  it("holds exactly these models", () => {
    // Sorted, one to a line, for the same reason as the ignore list above.
    assert.deepEqual(
      rows.map((r) => `${r.kind} | ${r.type} | ${r.path} | ${r.rest}`).sort(),
      [
        "barrierModel | file:main/services/builtin-cues.ts | Member[layerSlug].ReturnValue | log-injection",
        "barrierModel | file:main/services/companion-export.ts | Member[slugForCue].ReturnValue | log-injection",
        "barrierModel | file:main/services/export-filename.ts | Member[filenameSlug].ReturnValue | log-injection",
        "barrierModel | file:main/services/scrub.ts | Member[scrubError].ReturnValue | log-injection",
        "barrierModel | file:main/services/scrub.ts | Member[scrub].ReturnValue | log-injection",
        "barrierModel | file:main/services/servicecue-publish-rules.ts | Member[parsePublishUrl].ReturnValue | request-forgery",
        "sourceModel | file:main/services/routes/context.ts | Member[readBodyOrEmpty].ReturnValue.Awaited | remote",
        "sourceModel | file:main/services/routes/context.ts | Member[readBody].ReturnValue.Awaited | remote",
        "sourceModel | file:main/services/routes/context.ts | Member[readRawBody].ReturnValue.Awaited | remote",
      ],
    );
  });

  it("names, for every model, a file in the repository that exports that function", () => {
    // A renamed function leaves the model matching nothing, and CodeQL says nothing about it.
    for (const r of rows) {
      const file = r.type.replace(/^file:/, "");
      assert.ok(tracked.includes(file), `${file} is not a tracked file`);
      const name = /^Member\[(\w+)\]/.exec(r.path)?.[1];
      assert.ok(name, r.path);
      assert.ok(exportsFunction(file, name), `${file} does not export a function ${name}`);
    }
  });

  it("has a stand-in for each of those files, at the same path, in the CodeQL test fixtures", () => {
    // The model reads a path relative to the source root, so the fixture sits at that path under the test's.
    for (const file of new Set(rows.map((r) => r.type.replace(/^file:/, ""))))
      assert.ok(tracked.includes(`.github/codeql/tests/models/${file}`), `no fixture stands in for ${file}`);
  });

  it("is the pack the test pack depends on", () => {
    const tests = parse(read(".github/codeql/tests/qlpack.yml")) as { extractor: string; dependencies: Record<string, string> };
    assert.equal(tests.extractor, "javascript");
    assert.ok(pack.name in tests.dependencies, "the test pack does not depend on the model pack");
  });

  it("is the pack the JavaScript analysis loads, through the options the action reads", () => {
    const step = analyze.steps?.find((s) => s.uses?.startsWith("github/codeql-action/analyze@"));
    const expr = String(step?.env?.["CODEQL_ACTION_EXTRA_OPTIONS"]);
    // Only the JavaScript run loads it: the pack extends a JavaScript library.
    assert.match(expr, /^\$\{\{ inputs\.language == 'javascript-typescript' && format\(/);
    const template = /format\('(.*)', github\.workspace\)/.exec(expr)?.[1];
    assert.ok(template, "no format() in CODEQL_ACTION_EXTRA_OPTIONS");
    // format() accepts a brace only as {{, }} or {0}; a lone one is an error on a runner.
    assert.doesNotMatch(template.replace("{0}", "").replace(/\{\{|\}\}/g, ""), /[{}]/, "a lone brace in the format string");
    const json = template.replace("{0}", "/work").replace(/\{\{/g, "{").replace(/\}\}/g, "}");
    assert.deepEqual(JSON.parse(json), {
      database: { "run-queries": ["--additional-packs=/work/.github/codeql/extensions", `--model-packs=${pack.name}`] },
    });
  });

  it("is tested by the model-test job, against the CLI the analysis installs", () => {
    const job = caller.jobs["models"];
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.ok(typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] <= 20);
    const setup = job.steps?.find((s) => s.uses?.startsWith("github/codeql-action/setup-codeql@"));
    assert.equal(setup?.with?.["languages"], "javascript-typescript");
    const run = job.steps?.find((s) => s.run?.includes("test run"));
    assert.equal(run?.env?.["CODEQL"], `\${{ steps.${setup?.id}.outputs.codeql-path }}`);
    assert.match(String(run?.run), /"\$CODEQL" test run \.github\/codeql\/tests --additional-packs="\$GITHUB_WORKSPACE\/\.github\/codeql\/extensions"/);
  });
});
