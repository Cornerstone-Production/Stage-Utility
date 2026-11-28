// How the repository's own scripts are started: every `node [flags] scripts/<file>.ts|.mjs`.
//
// Scanned: the `run:` strings of every workflow (.github/workflows/*.yml) and composite action
// (.github/actions/*/action.yml), parsed so a YAML comment that names a script does not count;
// the `scripts` of every package.json outside node_modules (publish/servicecue's included); and
// every .sh and .ps1 file, and every extensionless shell script under scripts/, as raw text.
// Backslash-newline continuations (and a backtick-newline in .ps1) are joined first. The path may
// follow `./`, a quote, `$VAR/` or `${VAR}/`, or PowerShell's `(Join-Path $var "`.
//
// Not seen: a call that does not go through a `scripts/` path (survival's run-windows.ps1 starts
// `$here\parent.ts`), and a script started by anything but `node`.
//
// A workflow step that still names a script by an old name fails only on the day that step runs,
// and a release-path step is one that runs on beta and main. So the invocations are one exact,
// sorted list, one per line, each naming its source file: a renamed script, a dropped flag or a
// new call shows as the line that changed.
//
// `--no-warnings` is on a call whose output a caller parses or shows. An early Node 24
// prints a type-stripping warning to stderr, and the coverage run merges stderr into the file
// it reads.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** Every `run:` string in a parsed workflow or action, at any depth. */
function runStrings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) runStrings(item, out);
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "run" && typeof value === "string") out.push(value);
      else runStrings(value, out);
    }
  }
  return out;
}

/** What may stand between `node`'s flags and `scripts/`: Join-Path, a quote, `./` or `$VAR/`. */
const PREFIX = String.raw`(?:\(Join-Path[ \t]+\$\w+[ \t]+)?["']?(?:\.\/|\$\{?\w+\}?\/)?`;
/** `node [flags] <prefix>scripts/<file>.ts|.mjs` wherever a command line has one. */
const INVOCATION = new RegExp(String.raw`\bnode((?:[ \t]+[^\s;&|<>()"']+)*?)[ \t]+${PREFIX}(scripts\/[\w./-]+\.(?:ts|mjs))\b`, "g");

/** One call: where it is written, the directory its path is relative to, and the line it pins. */
interface Call {
  source: string;
  base: string;
  flags: string;
  script: string;
}

const render = (c: Call) => `${c.source}: node${c.flags} ${c.script}`;

function invocations(source: string, base: string, text: string, { ps1 = false } = {}): Call[] {
  const joined = text.replace(ps1 ? /[\\`]\r?\n[ \t]*/g : /\\\r?\n[ \t]*/g, " ");
  return [...joined.matchAll(INVOCATION)].map((m) => ({ source, base, flags: m[1]!, script: m[2]! }));
}

const SKIP_DIRS = new Set(["node_modules", "build", "dist", "coverage"]);

/** Every file in the repository, skipping dependencies, build output and dot-directories other than .github. */
function files(dir = ROOT, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue;
      files(full, out);
    } else if (e.isFile()) out.push(full);
  }
  return out;
}

/** An extensionless file under scripts/ that a shell runs. */
function isShellScript(file: string): boolean {
  if (path.extname(file) !== "" || !rel(file).startsWith("scripts/")) return false;
  const first = fs.readFileSync(file, "utf8").split("\n", 1)[0]!;
  return /^#!.*\b(?:ba|z|da)?sh\b/.test(first);
}

/** Every call, in no particular order. */
function calls(): Call[] {
  const out: Call[] = [];
  for (const file of files()) {
    const name = rel(file);
    if (/^\.github\/workflows\/[^/]+\.yml$/.test(name) || /^\.github\/actions\/[^/]+\/action\.yml$/.test(name)) {
      for (const run of runStrings(parse(fs.readFileSync(file, "utf8")) as unknown)) out.push(...invocations(name, ROOT, run));
    } else if (path.basename(file) === "package.json") {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { scripts?: Record<string, string> };
      for (const [script, command] of Object.entries(pkg.scripts ?? {})) out.push(...invocations(`${name} ${script}`, path.dirname(file), command));
    } else if (file.endsWith(".sh") || file.endsWith(".ps1") || isShellScript(file)) {
      out.push(...invocations(name, ROOT, fs.readFileSync(file, "utf8"), { ps1: file.endsWith(".ps1") }));
    }
  }
  return out;
}

function collect(): string[] {
  return calls().map(render).sort();
}

describe("how the scripts are started", () => {
  it("is exactly this list, one call to a line", () => {
    assert.deepEqual(collect(), [
      ".github/workflows/ci.yml: node --import tsx --test scripts/servicecue-bundle-wrangler.test.ts",
      ".github/workflows/ci.yml: node --import tsx --test scripts/update-scripts.test.ts",
      ".github/workflows/commit-lint.yml: node scripts/check-beta-only.ts",
      ".github/workflows/commit-lint.yml: node scripts/check-commit-subjects.ts",
      ".github/workflows/coverage.yml: node --no-warnings scripts/run-tests.ts",
      ".github/workflows/public-hygiene.yml: node scripts/check-public-hygiene.ts",
      ".github/workflows/release.yml: node --no-warnings scripts/release-notes.ts",
      ".github/workflows/release.yml: node --no-warnings scripts/update-homebrew-formula.ts",
      ".github/workflows/release.yml: node --no-warnings scripts/verified-tree.ts",
      "package.json build: node --import tsx scripts/servicecue-bundle.ts",
      "package.json docs:screenshots: node scripts/docs-screenshots/run.ts",
      "package.json icons: node scripts/build-icons.ts",
      "package.json servicecue:bundle: node --import tsx scripts/servicecue-bundle.ts",
      "package.json servicecue:deploy-try: node --import tsx scripts/servicecue-deploy-try.ts",
      "package.json test: node scripts/run-tests.ts",
      "publish/servicecue/package.json deploy: node scripts/deploy.ts",
      "scripts/build-artifacts.sh: node --import tsx scripts/servicecue-bundle.ts",
      "scripts/build-artifacts.sh: node scripts/bundle-server.ts",
      "scripts/build-artifacts.sh: node scripts/stage-native-modules.ts",
      "scripts/update.ps1: node --no-warnings scripts/build-inputs.ts",
      "scripts/update.ps1: node --no-warnings scripts/manifest-changed.ts",
      "scripts/update.sh: node --no-warnings scripts/build-inputs.ts",
      "scripts/update.sh: node --no-warnings scripts/manifest-changed.ts",
    ]);
  });

  it("names only scripts that exist", () => {
    const missing = calls()
      .filter((c) => !fs.existsSync(path.join(c.base, c.script)))
      .map(render)
      .sort();
    assert.deepEqual(missing, []);
  });
});

// A step that runs a TypeScript script needs Node 24 to strip its types, and a runner image's own
// Node may be older. So every workflow job with such a step sets up Node 24 in an earlier step of
// the same job. A step runs TypeScript when its run string (each value of a `${{ matrix.x }}` in
// it) starts `node` on a .ts file, runs an npm script that does (`npm test`, `npm run x`,
// `npm --prefix dir run x`, followed through npm scripts that call npm), or starts a .sh or
// .ps1 under scripts/ whose own text starts `node` on a .ts file. That last is one level deep: a
// script started by a script is not followed, and neither is node started through a variable
// (the survival runners' "$NODE" "$HERE/parent.ts").

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  steps?: Step[];
  strategy?: { matrix?: Record<string, unknown> };
}

/** `node [flags] <something>.ts` anywhere on a command line, scripts/ or not (`node --test test/*.test.ts`). */
const TS_RUN = /\bnode(?:[ \t]+[^\s;&|<>]+)*?[ \t]+\S*\.ts\b/;
/** `npm test`, `npm start`, `npm run[-script] x`, each with an optional `--prefix dir`. */
const NPM_RUN = /\bnpm[ \t]+(?:--prefix[ \t]+(\S+)[ \t]+)?(?:run(?:-script)?[ \t]+([\w:.-]+)|(test|start)\b)/g;
/** A .sh or .ps1 under scripts/ started as a command: at the start of one, or after bash, sh, pwsh or &. */
const SCRIPT_RUN = /(?:^|[;&|({]|\$\()[ \t]*(?:(?:bash|sh|pwsh(?:[ \t]+-File)?|&)[ \t]+)?["']?(?:\.\/|\$\{?\w+\}?\/)?(scripts\/[\w./-]+\.(?:sh|ps1))\b/gm;

function startsTs(text: string, dir: string, seen = new Set<string>()): boolean {
  if (TS_RUN.test(text.replace(/\\\r?\n[ \t]*/g, " "))) return true;
  for (const m of text.matchAll(NPM_RUN)) {
    const pkgDir = path.resolve(dir, m[1] ?? ".");
    const name = m[2] ?? m[3]!;
    const key = `${pkgDir}#${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const command = pkg.scripts?.[name];
    if (command !== undefined && startsTs(command, pkgDir, seen)) return true;
  }
  for (const m of text.matchAll(SCRIPT_RUN)) {
    const file = path.join(ROOT, m[1]!);
    if (fs.existsSync(file) && TS_RUN.test(fs.readFileSync(file, "utf8").replace(/[\\`]\r?\n[ \t]*/g, " "))) return true;
  }
  return false;
}

/** A run string once per value of each `${{ matrix.x }}` in it. */
function expandMatrix(run: string, matrix: Record<string, unknown> | undefined): string[] {
  const keys = [...run.matchAll(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g)].map((m) => m[1]!);
  if (keys.length === 0 || !matrix) return [run];
  let out = [run];
  for (const key of new Set(keys)) {
    const include = Array.isArray(matrix["include"]) ? (matrix["include"] as Record<string, unknown>[]).map((row) => row[key]) : [];
    const values = [...(Array.isArray(matrix[key]) ? (matrix[key] as unknown[]) : []), ...include].filter((v) => v !== undefined).map(String);
    const token = new RegExp(String.raw`\$\{\{\s*matrix\.${key}\s*\}\}`, "g");
    out = values.length === 0 ? out : out.flatMap((r) => values.map((v) => r.replace(token, v)));
  }
  return out;
}

/** Per job that runs TypeScript: its name, and the steps that run it with no Node 24 set up before them. */
function nodeJobs(): { jobs: string[]; unready: string[] } {
  const jobs: string[] = [];
  const unready: string[] = [];
  const dir = path.join(ROOT, ".github", "workflows");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".yml")).sort()) {
    const doc = parse(fs.readFileSync(path.join(dir, file), "utf8")) as { jobs?: Record<string, Job> };
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      const steps = job.steps ?? [];
      let ready: boolean | string = false;
      let runsTs = false;
      steps.forEach((step, i) => {
        if (step.uses?.startsWith("actions/setup-node@")) {
          const version = String(step.with?.["node-version"] ?? "");
          const major = /^(\d+)(?:\.|$|\.x)/.exec(version);
          ready = major === null ? `step ${i + 1} sets up Node "${version}", which is not a version this can read` : Number(major[1]) >= 24 || `step ${i + 1} sets up Node ${version}`;
        }
        if (step.run === undefined || !expandMatrix(step.run, job.strategy?.matrix).some((run) => startsTs(run, ROOT))) return;
        runsTs = true;
        if (ready !== true) unready.push(`${file} ${id}: step ${i + 1} (${step.name ?? step.run.split("\n")[0]}) runs TypeScript, ${ready === false ? "with no setup-node before it" : `but ${ready}`}`);
      });
      if (runsTs) jobs.push(`${file} ${id}`);
    }
  }
  return { jobs: jobs.sort(), unready };
}

describe("a workflow job that runs a TypeScript script", () => {
  const { jobs, unready } = nodeJobs();

  it("sets up Node 24 in an earlier step of the same job", () => {
    assert.deepEqual(unready, []);
  });

  it("is one of exactly these, so a scan that finds none cannot pass", () => {
    assert.deepEqual(jobs, [
      "ci.yml checks",
      "ci.yml test",
      "ci.yml worker",
      "commit-lint.yml conventional-commits",
      "coverage.yml coverage",
      "public-hygiene.yml hygiene",
      "release.yml already-verified",
      "release.yml archives",
      "release.yml artifacts",
      "release.yml verify-checks",
      "release.yml verify-tests",
    ]);
  });
});
