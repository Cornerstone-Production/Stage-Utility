// The release workflow's Mac output helper jobs.
//
// They must be harmless until the helper exists. Merging the workflow before
// helper/macos/build-app.sh is in the tree has to leave a release exactly as it
// was: the macOS job SKIPPED, nothing waiting on it, the release created as ever.
//
// The workflow is parsed, not searched. The `if` is evaluated against each state
// the gate can be in, and the gate's own shell is run against a tree with and
// without the script, so a gate that no longer looks at the file goes red.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(HERE, "..", ".github", "workflows", "release.yml");

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  outputs?: Record<string, string>;
  steps?: Step[];
}
const doc = parse(fs.readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, Job> };
const jobs = doc.jobs;
const needsOf = (j: Job): string[] => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);

type Ctx = { published: string; present: string };

/** Evaluate the subset of the expression language these `if`s use: always(),
 *  needs.<job>.outputs.<name> == '<literal>', and &&. Anything else throws, so a
 *  new shape is noticed rather than read as true. */
function evaluate(expr: string, ctx: Ctx): boolean {
  const body = expr.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  return body.split("&&").every((raw) => {
    const clause = raw.trim();
    if (clause === "always()") return true;
    const m = /^needs\.([\w-]+)\.outputs\.(\w+) == '([^']*)'$/.exec(clause);
    if (!m) throw new Error(`cannot evaluate: ${clause}`);
    const [, job, name, literal] = m;
    const value = job === "release" && name === "published" ? ctx.published : job === "helper-gate" && name === "present" ? ctx.present : undefined;
    if (value === undefined) throw new Error(`unknown output needs.${job}.outputs.${name}`);
    return value === literal;
  });
}

describe("the helper job is gated on the build script being in the tree", () => {
  const helper = jobs["helper"];
  const gate = jobs["helper-gate"];

  it("exists, on a macOS runner new enough for the helper, with a bounded run", () => {
    assert.ok(helper, "no helper job");
    assert.match(String(helper["runs-on"]), /^macos-(\d+)$/);
    assert.ok(Number(String(helper["runs-on"]).split("-")[1]) >= 14, "the helper needs macOS 14 or later to build");
    assert.ok(typeof helper["timeout-minutes"] === "number" && helper["timeout-minutes"] <= 90, "an unbounded macOS job would hold the release");
  });

  it("is skipped unless the gate found the script, and only for a published tag", () => {
    assert.ok(helper.if);
    assert.ok(helper.if.split("&&").map((c) => c.replace(/[${}\s]/g, "")).includes("always()"), "without always() a skipped gate would skip the helper by default, and so would a failed release step");
    const run = (published: string, present: string) => evaluate(helper.if as string, { published, present });
    assert.equal(run("true", "true"), true, "published and present: build");
    assert.equal(run("true", "false"), false, "no build script: SKIPPED");
    assert.equal(run("true", ""), false, "a gate that produced nothing is not a yes");
    assert.equal(run("false", "true"), false, "a run that stood down builds nothing");
    assert.equal(run("", "true"), false);
  });

  it("waits for the gate, and the gate for the release", () => {
    assert.ok(needsOf(helper).includes("helper-gate"));
    assert.ok(needsOf(helper).includes("release"));
    assert.deepEqual(needsOf(gate), ["release"]);
  });

  it("gets its answer from a step that tests for helper/macos/build-app.sh", () => {
    assert.equal(gate.outputs?.["present"], "${{ steps.probe.outputs.present }}");
    const probe = gate.steps?.find((s) => s.id === "probe");
    assert.ok(probe?.run, "the gate has no probe step");
    // The probe's own shell, run on a tree with and without the script. The
    // workflow expression in its notice line is filled in the way Actions would.
    const script = probe.run.replace(/\$\{\{\s*needs\.release\.outputs\.version\s*\}\}/g, "1.2.3");
    for (const [withScript, expected] of [[true, "true"], [false, "false"]] as const) {
      const tree = fs.mkdtempSync(path.join(os.tmpdir(), "su-gate-"));
      try {
        if (withScript) {
          fs.mkdirSync(path.join(tree, "helper", "macos"), { recursive: true });
          fs.writeFileSync(path.join(tree, "helper", "macos", "build-app.sh"), "#!/bin/sh\n");
        }
        const out = path.join(tree, "output");
        fs.writeFileSync(out, "");
        const r = spawnSync("bash", ["-c", script], { cwd: tree, env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out }, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(out, "utf8").trim(), `present=${expected}`, `with${withScript ? "" : "out"} the script`);
      } finally {
        fs.rmSync(tree, { recursive: true, force: true });
      }
    }
  });

  it("builds both architectures through build-app.sh --arch and writes a checksum for each", () => {
    const build = helper.steps?.find((s) => s.run?.includes("build-app.sh"));
    assert.ok(build?.run);
    assert.match(build.run, /for arch in arm64 x86_64/);
    assert.match(build.run, /helper\/macos\/build-app\.sh --arch "\$arch"/);
    assert.match(build.run, /StageUtilityOutput-\$arch\.zip"/);
    assert.match(build.run, /shasum -a 256 "StageUtilityOutput-\$arch\.zip" > "StageUtilityOutput-\$arch\.zip\.sha256"/);
  });
});

describe("the release itself is unchanged by the helper", () => {
  const artifacts = jobs["artifacts"];

  it("still creates the release whatever the helper does", () => {
    assert.ok(needsOf(artifacts).includes("release"));
    assert.ok(needsOf(artifacts).includes("helper"));
    // A skipped, failed or cancelled helper must not stop the archives. That is
    // what always() does; evaluate() treats it as true, so it has to be there.
    assert.ok((artifacts.if as string).split("&&").map((c) => c.replace(/[${}\s]/g, "")).includes("always()"), "artifacts must run whatever the helper did");
    const run = (published: string, present: string) => evaluate(artifacts.if as string, { published, present });
    assert.equal(run("true", "false"), true);
    assert.equal(run("true", "true"), true);
    assert.equal(run("false", "false"), false, "a stand-down still builds nothing");
  });

  it("the release job does not wait on the macOS build, and keeps its own gates", () => {
    const release = jobs["release"];
    assert.deepEqual(needsOf(release).sort(), ["verify-checks", "verify-tests"]);
    const push = release.steps?.find((s) => s.id === "push");
    assert.ok(push?.run?.includes('git push origin "HEAD:${GITHUB_REF_NAME}"'), "the bump is still pushed fast-forward only");
    assert.ok(!push?.run?.includes("--force"));
  });

  it("downloads the helper's artifact only from a helper that succeeded, under the name it was uploaded as", () => {
    const upload = jobs["helper"].steps?.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    const download = artifacts.steps?.find((s) => s.uses?.startsWith("actions/download-artifact@"));
    assert.ok(upload && download, "upload or download step missing");
    assert.equal(download.with?.["name"], upload.with?.["name"]);
    assert.equal(download.if, "${{ needs.helper.result == 'success' }}");
  });

  it("attaches the helper's files to the one release-create call", () => {
    const create = artifacts.steps?.find((s) => s.run?.includes("gh release create"));
    assert.ok(create?.run);
    assert.match(create.run, /if \[ -d helper-dist \]; then assets\+=\(helper-dist\/\*\); fi/);
    assert.match(create.run, /gh release create "v\$V"[\s\S]*"\$\{assets\[@\]\}"/);
    assert.equal(create.run.match(/gh release create/g)?.length, 1);
    assert.equal(create.run.includes("gh release upload"), false, "a published release cannot be added to");
  });
});
