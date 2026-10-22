// update-scripts.test.ts — the update scripts, run whole, decide what to build.
//
// update.sh and update.ps1 pull a release into a git checkout and then run `npm ci` and
// `npm run build` only if something they read changed. A decision line moved above the
// variable it sets, or a regex left behind in one of the two scripts, passes every test
// that reads the text. So this runs the real scripts, on a real git repository with two
// commits and a remote, with a stand-in `npm` first on the PATH that records how it was
// called, and asserts what ran.
//
// update.ps1 runs under pwsh where there is one. CI's `worker` job runs on ubuntu, which
// has pwsh, and sets UPDATE_REQUIRE_PWSH so that a missing pwsh there is a failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "update-scripts-"));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).status === 0;
const pwshRequired = process.env.UPDATE_REQUIRE_PWSH === "1";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

const write = (root: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

/** A stand-in for npm: records its arguments, one call per line, and succeeds. */
function stubBin(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "$@" >> "${path.join(dir, "npm-calls")}"\n`, { mode: 0o755 });
  return bin;
}

interface Case {
  /** Files the update changes, by path. */
  changes: string[];
  /** Whether the checkout has the page's bundle from the last build. */
  hasBundle?: boolean;
}

/** One update, whole: what npm was asked to do. */
function runUpdate(script: "update.sh" | "update.ps1", c: Case): string[] {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "case-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  git(repo, "checkout", "-q", "-b", "main");

  // What the scripts call from the checkout, and a manifest that never changes.
  for (const f of ["manifest-changed.mjs", "build-inputs.mjs", "is-main.mjs"]) write(repo, `scripts/${f}`, fs.readFileSync(path.join(SCRIPTS, f), "utf8"));
  write(repo, "package.json", '{"name":"x","version":"1.0.0","scripts":{}}\n');
  write(repo, "package-lock.json", '{"name":"x","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"x","version":"1.0.0"}}}\n');
  write(repo, "README.md", "first\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "push", "-q", "origin", "main");

  // The checkout has been built before.
  fs.mkdirSync(path.join(repo, "build/renderer"), { recursive: true });
  if (c.hasBundle !== false) write(repo, "build/servicecue/deploy.json", "{}");

  // The update lands: a second commit on origin, from another clone.
  const other = path.join(dir, "other");
  git(dir, "clone", "-q", origin, other);
  for (const f of c.changes) write(other, f, `changed ${f}\n`);
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "second");
  git(other, "push", "-q", "origin", "main");

  const bin = stubBin(dir);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    STAGE_UPDATE_REPO: repo,
    STAGE_UPDATE_BRANCH: "main",
    STAGE_UPDATE_RESULT: path.join(dir, "result.json"),
    STAGE_UPDATE_PROGRESS: path.join(dir, "progress.json"),
    STAGE_UPDATE_LIVE_LOG: path.join(dir, "live.log"),
    STAGE_UPDATE_DEFER_RESTART: "1",
    STAGE_UPDATE_TAG: "",
  };
  const run =
    script === "update.sh"
      ? spawnSync("bash", [path.join(SCRIPTS, "update.sh")], { env, encoding: "utf8" })
      : spawnSync("pwsh", ["-NoProfile", "-File", path.join(SCRIPTS, "update.ps1")], { env, encoding: "utf8" });
  const log = fs.existsSync(path.join(dir, "live.log")) ? fs.readFileSync(path.join(dir, "live.log"), "utf8") : "";
  assert.equal(run.status, 0, `${script}: ${run.stdout}${run.stderr}\n${log}`);
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as { ok: boolean };
  assert.equal(result.ok, true, log);
  const calls = path.join(dir, "npm-calls");
  return fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];
}

const SCRIPT_LIST: ["update.sh" | "update.ps1", boolean | string][] = [
  ["update.sh", true],
  ["update.ps1", pwsh || pwshRequired ? true : "pwsh is not installed (CI requires it)"],
];

for (const [script, available] of SCRIPT_LIST) {
  describe(`${script}, run whole`, { skip: available === true ? false : String(available) }, () => {
    test("a renderer change builds, and does not reinstall", () => {
      assert.deepEqual(runUpdate(script, { changes: ["renderer/app/x.tsx"] }), ["run build"]);
    });

    test("a change to the page's Worker builds", () => {
      assert.deepEqual(runUpdate(script, { changes: ["publish/servicecue/src/hub.ts"] }), ["run build"]);
    });

    test("a change to a module the interface and the page share builds", () => {
      assert.deepEqual(runUpdate(script, { changes: ["main/services/clamp.ts"] }), ["run build"]);
    });

    test("a change to docs only builds nothing", () => {
      assert.deepEqual(runUpdate(script, { changes: ["docs/ops/x.md", "README.md"] }), []);
    });

    test("a checkout with no page bundle, because the last bundle failed, reinstalls and builds even for docs", () => {
      assert.deepEqual(runUpdate(script, { changes: ["docs/ops/x.md"], hasBundle: false }), ["ci --include=dev", "run build"]);
    });
  });
}
