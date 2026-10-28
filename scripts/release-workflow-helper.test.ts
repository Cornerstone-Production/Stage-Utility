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
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
}
const doc = parse(fs.readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, Job> };
const jobs = doc.jobs;
const needsOf = (j: Job): string[] => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);

type Ctx = { published: string; present: string; helperResult?: string };

/** Evaluate the subset of the expression language these `if`s use: always(),
 *  needs.<job>.outputs.<name> == '<literal>', needs.helper.result == '<literal>',
 *  &&, and ||. Anything else throws, so a new shape is noticed rather than read as true. */
function evaluate(expr: string, ctx: Ctx): boolean {
  const body = expr.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const clauseHolds = (clause: string): boolean => {
    if (clause === "always()") return true;
    const result = /^needs\.helper\.result == '([^']*)'$/.exec(clause);
    if (result) {
      if (ctx.helperResult === undefined) throw new Error("this evaluation has no helper result");
      return ctx.helperResult === result[1];
    }
    const m = /^needs\.([\w-]+)\.outputs\.(\w+) == '([^']*)'$/.exec(clause);
    if (!m) throw new Error(`cannot evaluate: ${clause}`);
    const [, job, name, literal] = m;
    const value = job === "release" && name === "published" ? ctx.published : job === "helper-gate" && name === "present" ? ctx.present : undefined;
    if (value === undefined) throw new Error(`unknown output needs.${job}.outputs.${name}`);
    return value === literal;
  };
  // || binds looser than && in Actions' expression language too, so split on it first.
  return body.split("||").some((alt) => alt.split("&&").every((raw) => clauseHolds(raw.trim())));
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
    // version reaches it through the step's env, as it does on a runner.
    assert.equal(probe.env?.["V"], "${{ needs.release.outputs.version }}");
    const script = probe.run;
    for (const [withScript, expected] of [[true, "true"], [false, "false"]] as const) {
      const tree = fs.mkdtempSync(path.join(os.tmpdir(), "su-gate-"));
      try {
        if (withScript) {
          fs.mkdirSync(path.join(tree, "helper", "macos"), { recursive: true });
          fs.writeFileSync(path.join(tree, "helper", "macos", "build-app.sh"), "#!/bin/sh\n");
        }
        const out = path.join(tree, "output");
        fs.writeFileSync(out, "");
        const r = spawnSync("bash", ["-c", script], { cwd: tree, env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, V: "1.2.3" }, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(out, "utf8").trim(), `present=${expected}`, `with${withScript ? "" : "out"} the script`);
      } finally {
        fs.rmSync(tree, { recursive: true, force: true });
      }
    }
  });

  it("builds both architectures through build-app.sh --arch and zips each", () => {
    const build = helper.steps?.find((s) => s.run?.includes("build-app.sh"));
    assert.ok(build?.run);
    assert.match(build.run, /for arch in arm64 x86_64/);
    assert.match(build.run, /helper\/macos\/build-app\.sh --arch "\$arch"/);
    assert.match(build.run, /StageUtilityOutput-\$arch\.zip"/);
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
    assert.ok(push?.run?.includes('git push "$REMOTE" "HEAD:${GITHUB_REF_NAME}"'), "the bump is still pushed fast-forward only");
    assert.ok(!push?.run?.includes("--force"));
  });

  it("keeps no credential after checkout, and hands the token to the push step alone", () => {
    const steps = jobs["release"].steps ?? [];
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout?.with?.["persist-credentials"], false, "the checkout keeps the token in git config");
    // The only step in the job that pushes is the one given the token.
    const pushers = steps.filter((s) => /\bgit push\b/.test(s.run ?? ""));
    assert.deepEqual(pushers.map((s) => s.id), ["push"]);
    assert.equal(pushers[0]?.env?.["GH_TOKEN"], "${{ github.token }}");
    assert.match(pushers[0]?.run ?? "", /REMOTE="https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/);
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
    assert.match(create.run, /if \[ -d helper-dist \]; then assets\+=\(helper-dist\/StageUtilityOutput-\*\.zip\); fi/);
    assert.match(create.run, /gh release create "v\$V"[\s\S]*"\$\{assets\[@\]\}"/);
    assert.equal(create.run.match(/gh release create/g)?.length, 1);
    assert.equal(create.run.includes("gh release upload"), false, "a published release cannot be added to");
  });
});

describe("the helper's download reaches the release", () => {
  const artifacts = jobs["artifacts"];
  const download = artifacts.steps?.find((st) => st.uses?.startsWith("actions/download-artifact@"));
  const create = artifacts.steps?.find((st) => st.run?.includes("gh release create"));

  /** The create step's own shell, run for real on a temp tree with `gh` and `node` stood in for. */
  function runCreate(populate: (tree: string) => void): { status: number | null; err: string; attached: string[] } {
    assert.ok(create?.run, "no create step");
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "su-create-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "su-create-bin-"));
    try {
      const log = path.join(tree, "gh.log");
      fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >>"$GH_LOG"; done\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.mkdirSync(path.join(tree, "dist"));
      for (const n of ["stage-utility-1.2.3-linux-x64.tar.gz", "stage-utility-1.2.3-darwin-arm64.tar.gz"]) fs.writeFileSync(path.join(tree, "dist", n), "x");
      // What the signing step leaves; without it no release is created
      // (scripts/release-signing-workflow.test.ts), which is not what these test.
      fs.mkdirSync(path.join(tree, "sig-dist"));
      fs.writeFileSync(path.join(tree, "sig-dist", "kiosk-windows.ps1.sig"), "s");
      populate(tree);
      // The step writes its notes to /tmp/notes.md; keep that inside the temp tree.
      const script = create.run!.replaceAll("/tmp/notes.md", path.join(tree, "notes.md"));
      const r = spawnSync("bash", ["-c", script], {
        cwd: tree,
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_LOG: log, GH_TOKEN: "x", V: "1.2.3", LAST: "v1.2.2", STABLE: "v1.2.0", PRE: "true" },
      });
      const args = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { status: r.status, err: r.stderr, attached: args.filter((a) => !a.startsWith("-") && /\.(tar\.gz|zip|sha256)$/.test(a)).sort() };
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }

  const HELPER_FILES = ["StageUtilityOutput-arm64.zip", "StageUtilityOutput-x86_64.zip"];
  const STRAY_FILES = ["StageUtilityOutput-arm64.zip.sha256", "StageUtilityOutput-x86_64.zip.sha256", "Other.zip"];
  const TARBALLS = ["dist/stage-utility-1.2.3-darwin-arm64.tar.gz", "dist/stage-utility-1.2.3-linux-x64.tar.gz"];

  it("attaches the zips the download step puts down, wherever that step is told to put them", () => {
    const dir = String(download?.with?.["path"]);
    assert.ok(dir && dir !== "undefined", "the download step has no path");
    const r = runCreate((tree) => {
      fs.mkdirSync(path.join(tree, dir), { recursive: true });
      for (const n of HELPER_FILES) fs.writeFileSync(path.join(tree, dir, n), "x");
      // Whatever else lands beside them is not published: the old checksum files, or a stray zip.
      for (const n of STRAY_FILES) fs.writeFileSync(path.join(tree, dir, n), "x");
    });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.attached, [...TARBALLS, ...HELPER_FILES.map((n) => `${dir}/${n}`)].sort());
  });

  it("still creates the release, with the archives only, when there is no helper download", () => {
    const r = runCreate(() => undefined);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.attached, TARBALLS);
  });

  it("says so, with an error annotation, only when the helper build failed or was cancelled", () => {
    const say = artifacts.steps?.find((st) => st.run?.includes("::error") && st.if?.includes("needs.helper.result"));
    assert.ok(say, "no step annotates a failed helper build");
    for (const [result, want] of [["failure", true], ["cancelled", true], ["success", false], ["skipped", false]] as const) {
      assert.equal(evaluate(say.if as string, { published: "true", present: "true", helperResult: result }), want, `helper ${result}`);
    }
    assert.match(say.run as string, /::error title=Mac output helper::.*failed or was cancelled.*released without StageUtilityOutput/);
    // The release is still created, and not behind that condition.
    assert.equal(create?.if, undefined, "the create step must not be conditional on the helper");
    assert.ok((artifacts.steps ?? []).indexOf(say) < (artifacts.steps ?? []).indexOf(create as Step), "the annotation comes before the release is created");
    assert.ok((artifacts.if as string).includes("always()"));
  });
});

describe("the helper jobs hold only the permissions they use", () => {
  it("the gate and the build read the repository and nothing else", () => {
    // The workflow's default is contents: write and statuses: write.
    assert.deepEqual(jobs["helper-gate"].permissions, { contents: "read" });
    assert.deepEqual(jobs["helper"].permissions, { contents: "read" });
  });
});

describe("the helper's signature is verified the way its build script verifies it", () => {
  it("uses codesign --verify --strict, never --deep, on both the build and the unpacked zip", () => {
    const build = jobs["helper"].steps?.find((st) => st.run?.includes("build-app.sh"));
    assert.ok(build?.run);
    // Comments explain why; only the commands count.
    const code = build.run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const verifies = code.match(/codesign --verify[^\n]*/g) ?? [];
    assert.deepEqual(verifies, ['codesign --verify --strict "$app"', 'codesign --verify --strict "$check/StageUtilityOutput.app"']);
    assert.ok(!code.includes("--deep"));
  });
});

