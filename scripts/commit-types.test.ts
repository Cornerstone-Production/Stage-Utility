// The shared commit-type list, and the two places that run real code over it: the
// release level (release-level.sh) and the release workflow's version step. The
// other readers are tested beside their own code, each looping over this list.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import COMMIT_TYPE_FILE from "../main/services/commit-types.json" with { type: "json" };
import INTERNAL_SCOPE_FILE from "../main/services/internal-scopes.json" with { type: "json" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "release.yml");

// Each list EXACTLY, one type per line: adding a type is a deliberate act, and has
// to be declared here, where two branches adding different ones merge cleanly.
// oxfmt-ignore
const MINOR = [
  "feat",
];
// oxfmt-ignore
const PATCH = [
  "fix",
  "perf",
  "polish",
];
// oxfmt-ignore
const INVISIBLE = [
  "build",
  "chore",
  "ci",
  "docs",
  "refactor",
  "test",
];
// oxfmt-ignore
const LEGACY = [
  "style",
];

/** Every type that may carry a `!`: all but revert. */
const BREAKABLE = [...COMMIT_TYPE_FILE.minor, ...COMMIT_TYPE_FILE.patch, ...COMMIT_TYPE_FILE.invisible];

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/**
 * A throwaway repository carrying the real release tooling, so the scripts run
 * against it as they run in the workflow: the level script, and the two JSON
 * files it reads relative to itself.
 */
function toolingRepo(version = "1.0.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-types-"));
  tmpDirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV }).trim();
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "main", "services"), { recursive: true });
  fs.copyFileSync(path.join(HERE, "release-level.sh"), path.join(dir, "scripts", "release-level.sh"));
  fs.chmodSync(path.join(dir, "scripts", "release-level.sh"), 0o755);
  for (const f of ["commit-types.json", "internal-scopes.json"]) {
    fs.copyFileSync(path.join(ROOT, "main", "services", f), path.join(dir, "main", "services", f));
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: seed");

  return {
    dir,
    git,
    commit(subject: string) {
      git("commit", "-q", "--allow-empty", "-m", subject);
    },
    setVersion(v: string) {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: v }));
      git("add", "package.json");
      git("commit", "-q", "-m", `chore(release): v${v} [skip ci]`);
    },
    level(range: string) {
      return execFileSync("bash", [path.join(dir, "scripts", "release-level.sh"), range], {
        cwd: dir,
        encoding: "utf8",
        env: GIT_ENV,
      }).trim();
    },
  };
}

describe("main/services/commit-types.json", () => {
  it("lists the types by level, exactly", () => {
    assert.deepEqual(COMMIT_TYPE_FILE.minor, MINOR);
    assert.deepEqual(COMMIT_TYPE_FILE.patch, PATCH);
    assert.deepEqual(COMMIT_TYPE_FILE.invisible, INVISIBLE);
    assert.deepEqual(COMMIT_TYPE_FILE.legacy, LEGACY);
    assert.deepEqual(COMMIT_TYPE_FILE.revert, ["revert"]);
  });

  it("keeps every list sorted", () => {
    for (const list of [COMMIT_TYPE_FILE.minor, COMMIT_TYPE_FILE.patch, COMMIT_TYPE_FILE.invisible, COMMIT_TYPE_FILE.legacy]) {
      assert.deepEqual(list, [...list].sort());
    }
  });
});

describe("release-level.sh reads the levels from the shared list", () => {
  const repo = toolingRepo();

  /** The level of one commit on its own. */
  function levelOf(subject: string): string {
    repo.commit(subject);
    return repo.level("HEAD~1..HEAD");
  }

  const LEVELS: Array<[readonly string[], string]> = [
    [COMMIT_TYPE_FILE.minor, "minor"],
    [COMMIT_TYPE_FILE.patch, "patch"],
    [COMMIT_TYPE_FILE.invisible, "none"],
    [COMMIT_TYPE_FILE.legacy, "none"],
    [COMMIT_TYPE_FILE.revert, "none"],
  ];

  it("each type releases at the level the list gives it, scoped or not", () => {
    for (const [types, level] of LEVELS) {
      for (const t of types) {
        for (const subject of [`${t}: a change`, `${t}(x): a change`]) assert.equal(levelOf(subject), level, subject);
      }
    }
  });

  it("a breaking change of any type but revert is a major", () => {
    for (const t of BREAKABLE) {
      for (const subject of [`${t}!: a change`, `${t}(x)!: a change`]) assert.equal(levelOf(subject), "major", subject);
    }
    // A revert has no `!` form, and the lint rejects one: it must not read as major here.
    for (const t of COMMIT_TYPE_FILE.revert) {
      for (const subject of [`${t}!: a change`, `${t}(x)!: a change`]) assert.equal(levelOf(subject), "none", subject);
    }
  });

  it("a minor or patch type scoped to the release tooling releases nothing", () => {
    for (const scope of INTERNAL_SCOPE_FILE.scopes) {
      for (const t of [...COMMIT_TYPE_FILE.minor, ...COMMIT_TYPE_FILE.patch]) {
        assert.equal(levelOf(`${t}(${scope}): machinery`), "none", `${t}(${scope})`);
      }
    }
  });

  it("a feat anywhere in the range keeps it a minor, whatever lands after", () => {
    repo.commit("feat(x): a capability");
    repo.commit("polish(y): spacing");
    repo.commit("fix(z): a bug");
    assert.equal(repo.level("HEAD~3..HEAD"), "minor");
    assert.equal(repo.level("HEAD~2..HEAD"), "patch");
  });
});

/** The workflow's own "Decide the version" step, which this file runs as written. */
function decideVersionScript(): string {
  const wf = parse(fs.readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, { steps?: Array<{ id?: string; run?: string }> }> };
  for (const job of Object.values(wf.jobs)) {
    const step = job.steps?.find((s) => s.id === "version");
    if (step?.run) return step.run;
  }
  throw new Error("release.yml has no step with id: version");
}

describe("the release workflow's Decide-the-version step", () => {
  const script = decideVersionScript();

  function decide(repo: ReturnType<typeof toolingRepo>, branch: "beta" | "main") {
    const out = path.join(repo.dir, ".gh-output");
    const summary = path.join(repo.dir, ".gh-summary");
    fs.writeFileSync(out, "");
    fs.writeFileSync(summary, "");
    const r = spawnSync("bash", ["-e", "-c", script], {
      cwd: repo.dir,
      encoding: "utf8",
      env: { ...GIT_ENV, GITHUB_REF_NAME: branch, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const outputs = Object.fromEntries(
      fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { outputs, stdout: r.stdout, summary: fs.readFileSync(summary, "utf8") };
  }

  it("a polish alone on a stable release is a patch", () => {
    const repo = toolingRepo();
    repo.git("tag", "v1.0.0");
    repo.commit("polish(patch): more room between rack rows");
    assert.equal(decide(repo, "main").outputs["version"], "1.0.1");
    assert.equal(decide(repo, "beta").outputs["version"], "1.0.1-beta.1");
  });

  it("a feat is a minor, and a polish after it rides the same minor", () => {
    const repo = toolingRepo();
    repo.git("tag", "v1.0.0");
    repo.commit("polish(patch): more room between rack rows");
    repo.setVersion("1.0.1-beta.1");
    repo.git("tag", "v1.0.1-beta.1");

    repo.commit("feat(patch): a printable diagram");
    const feat = decide(repo, "beta");
    assert.equal(feat.outputs["version"], "1.1.0-beta.1");
    assert.equal(feat.outputs["level"], "minor");
    repo.setVersion("1.1.0-beta.1");
    repo.git("tag", "v1.1.0-beta.1");

    // The polish alone is patch-level news, but the pending release is still the
    // minor the feat opened — it must not pull the base back to a patch, and it
    // must not push it on to 1.2.0.
    repo.commit("polish(patch): the diagram legend sits closer to its title");
    const next = decide(repo, "beta");
    assert.equal(next.outputs["version"], "1.1.0-beta.2");
    assert.equal(next.outputs["level"], "minor");
    assert.equal(decide(repo, "main").outputs["version"], "1.1.0");
  });

  it("a polish scoped to the tooling stands down, and the run names the types that do release", () => {
    const repo = toolingRepo();
    repo.git("tag", "v1.0.0");
    repo.commit("polish(release): a nicer summary table");
    repo.commit("docs: a note");
    const r = decide(repo, "beta");
    assert.equal(r.outputs["skip"], "true");

    // The step spells the shared list out by hand, so what it printed has to agree.
    const tk = (t: string) => `\`${t}\``;
    const releasing = [...COMMIT_TYPE_FILE.minor, ...COMMIT_TYPE_FILE.patch];
    const quiet = [...COMMIT_TYPE_FILE.invisible, ...COMMIT_TYPE_FILE.revert].map(tk);
    assert.ok(r.summary.includes(`Only ${releasing.map(tk).join(", ")} or a breaking change trigger a release.`), r.summary);
    assert.ok(r.summary.includes(`${quiet.slice(0, -1).join(", ")} and ${quiet.at(-1)} do not, and`), r.summary);
    assert.ok(r.summary.includes(`neither does a ${releasing.map(tk).join("/")} scoped to the release tooling itself`), r.summary);
    assert.ok(r.stdout.includes(`none of them ${releasing.join("/")}.`), r.stdout);
  });
});
