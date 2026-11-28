import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { GATE_JOBS, gatePassed, sameButVersion } from "./verified-tree.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("sameButVersion", () => {
  let repo = "";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(repo, name), typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
  const commit = (msg: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const pkg = (v: string, dep = "1.0.0") => ({ name: "app", version: v, dependencies: { dep: `^${dep}` } });
  // The range stays ^1.0.0; `installed` is what the lock resolved it to, as a refresh within range moves it.
  const lock = (v: string, installed = "1.0.0") => ({
    name: "app",
    version: v,
    lockfileVersion: 3,
    packages: { "": { name: "app", version: v, dependencies: { dep: "^1.0.0" } }, "node_modules/dep": { version: installed } },
  });
  let verified = "";

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "su-verified-"));
    git("init", "-q", "-b", "beta");
    write("package.json", pkg("1.2.0-beta.3"));
    write("package-lock.json", lock("1.2.0-beta.3"));
    write("app.ts", "export const a = 1;\n");
    write("manifest.json", { name: "m", version: "1" });
    verified = commit("feat: the verified commit");
  });
  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  // Each case builds on the verified commit, then goes back to it.
  const onTop = (change: () => void) => {
    git("checkout", "-q", "-B", "case", verified);
    change();
    commit("case");
    return sameButVersion(verified, repo);
  };

  it("is true for the release bump: the project's own version, in both files", () => {
    assert.equal(onTop(() => {
      write("package.json", pkg("1.2.0"));
      write("package-lock.json", lock("1.2.0"));
    }), true);
  });

  it("is true for the very same tree", () => {
    assert.equal(onTop(() => write("app.ts", "export const a = 1;\n")), true);
  });

  it("is false when a dependency's version changes in the lockfile, though it is a version line too", () => {
    assert.equal(onTop(() => {
      write("package.json", pkg("1.2.0"));
      write("package-lock.json", lock("1.2.0", "1.0.1"));
    }), false);
  });

  it("is false when any other file changes", () => {
    assert.equal(onTop(() => {
      write("package.json", pkg("1.2.0"));
      write("app.ts", "export const a = 2;\n");
    }), false);
  });

  it("is false when another JSON file's version changes, though it looks like a bump", () => {
    assert.equal(onTop(() => {
      write("package.json", pkg("1.2.0"));
      write("manifest.json", { name: "m", version: "2" });
    }), false);
  });

  it("is false when package.json changes beyond its version", () => {
    assert.equal(onTop(() => write("package.json", pkg("1.2.0", "2.0.0"))), false);
  });

  it("is false for a commit not in HEAD's history, even with an identical tree", () => {
    git("checkout", "-q", "-B", "case2", verified);
    // Same tree as HEAD, parent-less: a verify of it says nothing about this history.
    const stray = execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit-tree", `${verified}^{tree}`, "-m", "stray"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(sameButVersion(stray, repo), false);
  });

  it("is false for a sha the repository does not have", () => {
    git("checkout", "-q", "-B", "case3", verified);
    assert.equal(sameButVersion("0".repeat(40), repo), false);
  });
});

describe("gatePassed", () => {
  const ok = GATE_JOBS.map((name) => ({ name, conclusion: "success" }));

  it("needs every gate job, each a success", () => {
    assert.equal(gatePassed(ok), true);
    assert.equal(gatePassed(ok.slice(1)), false, "a missing job");
    assert.equal(gatePassed(ok.map((j, i) => (i === 2 ? { ...j, conclusion: "failure" } : j))), false, "a failed shard");
    assert.equal(gatePassed(ok.map((j, i) => (i === 0 ? { ...j, conclusion: "skipped" } : j))), false, "a skipped job did not verify anything");
  });

  it("names exactly the verify jobs release.yml runs", () => {
    // The lookup matches jobs by name; a renamed job would match nothing, and the gate
    // would quietly run every time. So the names come from the workflow itself.
    const wf = parse(fs.readFileSync(path.join(HERE, "..", ".github", "workflows", "release.yml"), "utf8")) as {
      jobs: Record<string, { name?: string; strategy?: { matrix?: { shard?: number[] } } }>;
    };
    const checks = wf.jobs["verify-checks"]!;
    const tests = wf.jobs["verify-tests"]!;
    const expanded = [checks.name!, ...(tests.strategy?.matrix?.shard ?? []).map((n) => tests.name!.replace("${{ matrix.shard }}", String(n)))];
    assert.deepEqual([...GATE_JOBS].sort(), expanded.sort());
  });
});
