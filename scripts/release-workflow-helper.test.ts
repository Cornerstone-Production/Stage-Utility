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
  name?: string;
  strategy?: { matrix?: Record<string, unknown> };
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  environment?: string;
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

  it("builds both architectures, one runner each, through build-app.sh --arch and zips each", () => {
    assert.deepEqual(helper.strategy?.matrix?.["arch"], ["arm64", "x86_64"]);
    const build = helper.steps?.find((s) => s.run?.includes("build-app.sh"));
    assert.ok(build?.run);
    assert.equal(build.env?.["ARCH"], "${{ matrix.arch }}");
    assert.match(build.run, /arch="\$ARCH"/);
    assert.match(build.run, /helper\/macos\/build-app\.sh --arch "\$arch"/);
    assert.match(build.run, /StageUtilityOutput-\$arch\.zip"/);
  });

  it("caches only the compiled CEF wrapper and the build tools, per architecture, keyed on what builds them", () => {
    const cache = helper.steps?.find((s) => s.uses?.startsWith("actions/cache@"));
    assert.ok(cache, "no cache step");
    assert.match(cache.uses!, /^actions\/cache@[0-9a-f]{40}$/, "pinned to a commit");
    const paths = String(cache.with?.["path"]).trim().split("\n").map((l) => l.trim()).sort();
    // Not helper/macos/.cef: CEF itself is downloaded and checksum-checked every run.
    assert.deepEqual(paths, ["helper/macos/.cef-build/${{ matrix.arch }}", "helper/macos/.tools"]);
    const key = String(cache.with?.["key"]);
    for (const part of ["${{ matrix.arch }}", "helper/macos/cef.json", "helper/macos/build-tools.txt", "helper/macos/CEFHost/**"]) assert.ok(key.includes(part), `the key does not depend on ${part}`);
    const steps = helper.steps ?? [];
    assert.ok(steps.indexOf(cache) < steps.findIndex((s) => s.run?.includes("build-app.sh")), "restored before the build");
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
    assert.deepEqual(needsOf(release).sort(), ["already-verified", "verify-checks", "verify-tests"]);
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
    assert.equal(pushers[0]?.env?.["GH_TOKEN"], "${{ steps.app-token.outputs.token }}");
    assert.match(pushers[0]?.run ?? "", /REMOTE="https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/);
  });

  // beta and main admit only the maintainer and the release app, and
  // GITHUB_TOKEN cannot be put on that list: a push made with it is refused.
  it("pushes with the release app's token, minted just before the push, and the job's own token cannot write", () => {
    const steps = jobs["release"].steps ?? [];
    assert.deepEqual(jobs["release"].permissions, { contents: "read", statuses: "write" });
    assert.equal(jobs["release"].environment, "release", "the app's key is an environment secret only beta and main can reach");
    const mint = steps.findIndex((s) => s.id === "app-token");
    const push = steps.findIndex((s) => s.id === "push");
    assert.equal(mint, push - 1, "the token is minted in the step right before the push");
    const step = steps[mint];
    assert.match(step?.uses ?? "", /^actions\/create-github-app-token@[0-9a-f]{40}$/);
    assert.equal(step?.if, steps[push]?.if, "minted on exactly the runs that push");
    assert.deepEqual(step?.with, {
      "client-id": "${{ vars.RELEASE_APP_CLIENT_ID }}",
      "private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
      "permission-contents": "write",
    });
    const holders = Object.entries(jobs).flatMap(([job, j]) =>
      (j.steps ?? []).filter((s) => JSON.stringify(s).includes("secrets.RELEASE_APP_PRIVATE_KEY")).map((s) => `${job}: ${s.name}`));
    assert.deepEqual(holders, ["release: Mint the release app token"]);
  });

  // An app-token push starts workflows, which a GITHUB_TOKEN push never did.
  it("pushes nothing that starts a workflow: the bump is [skip ci], and no push trigger matches the tag", () => {
    const push = jobs["release"].steps?.find((s) => s.id === "push");
    const commits = (push?.run ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("git commit"));
    assert.deepEqual(commits, ['git commit -m "chore(release): v$V [skip ci]"']);
    // A push trigger with no branches filter (or with a tags filter) matches a
    // tag push, and path filters are not evaluated for tags.
    const dir = path.dirname(WORKFLOW);
    const onTags = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().filter((f) => {
      const on = (parse(fs.readFileSync(path.join(dir, f), "utf8")) as { on?: unknown }).on;
      if (on === "push" || (Array.isArray(on) && on.includes("push"))) return true;
      const trigger = (on as Record<string, Record<string, unknown> | null> | undefined)?.["push"];
      if (trigger === undefined) return false;
      return trigger === null || !("branches" in trigger) || "tags" in trigger;
    });
    assert.deepEqual(onTags, []);
  });

  it("downloads every architecture's artifact only from a helper that succeeded, by a pattern that matches each name", () => {
    const upload = jobs["helper"].steps?.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    assert.ok(upload, "upload step missing");
    const names = (jobs["helper"].strategy?.matrix?.["arch"] as string[]).map((a) => String(upload.with?.["name"]).replace("${{ matrix.arch }}", a));
    assert.deepEqual(names, ["output-helper-arm64", "output-helper-x86_64"]);
    for (const job of ["sign", "artifacts"]) {
      const download = jobs[job].steps?.find((s) => s.name === "Fetch the Mac output helper");
      assert.ok(download, `${job} does not fetch the helper`);
      const glob = new RegExp(`^${String(download.with?.["pattern"]).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      for (const n of names) assert.match(n, glob, `${job}'s pattern misses ${n}`);
      assert.equal(download.with?.["merge-multiple"], true, `${job} would put each zip in a folder of its own`);
      assert.equal(download.if, "${{ needs.helper.result == 'success' }}");
    }
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
  const download = artifacts.steps?.find((st) => st.name === "Fetch the Mac output helper");
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
      populate(tree);
      // The step writes its notes to /tmp/notes.md; keep that inside the temp tree.
      const script = create.run!.replaceAll("/tmp/notes.md", path.join(tree, "notes.md"));
      const r = spawnSync("bash", ["-c", script], {
        cwd: tree,
        encoding: "utf8",
        // No signatures here (scripts/release-signing-workflow.test.ts covers them):
        // the release is still created, which is what these test.
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_LOG: log, GH_TOKEN: "x", V: "1.2.3", LAST: "v1.2.2", STABLE: "v1.2.0", PRE: "true", RUNNER_TEMP: tree },
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
    // The workflow's default is contents: read; these say so themselves.
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


describe("the archives are built beside the helper, not after it", () => {
  const archives = jobs["archives"];
  const artifacts = jobs["artifacts"];

  it("waits only for the tag, and runs whatever happens to the release job after it", () => {
    assert.deepEqual(needsOf(archives), ["release"]);
    assert.equal(evaluate(archives.if as string, { published: "true", present: "false" }), true);
    assert.equal(evaluate(archives.if as string, { published: "false", present: "false" }), false, "a stand-down builds nothing");
    assert.ok((archives.if as string).includes("always()"));
  });

  it("builds, assembles and smoke-tests the tagged tree, and hands dist/ on", () => {
    const steps = archives.steps ?? [];
    assert.equal(steps.find((st) => st.uses?.startsWith("actions/checkout@"))?.with?.["ref"], "v${{ needs.release.outputs.version }}");
    const at = (pred: (st: Step) => boolean) => steps.findIndex(pred);
    const build = at((st) => /npm run build/.test(st.run ?? ""));
    const assemble = at((st) => /scripts\/build-artifacts\.sh/.test(st.run ?? ""));
    const smoke = at((st) => st.name === "Smoke-test the Linux archive");
    const upload = at((st) => st.uses?.startsWith("actions/upload-artifact@") === true);
    assert.ok(build >= 0 && build < assemble && assemble < smoke && smoke < upload, "build, assemble, smoke-test, upload, in that order");
    assert.equal(steps[upload]?.with?.["name"], "archives");
    assert.equal(steps[upload]?.with?.["path"], "dist/");
  });

  it("is what the publish job releases: fetched into dist before the create, and nothing built there", () => {
    assert.ok(needsOf(artifacts).includes("archives"));
    const steps = artifacts.steps ?? [];
    const fetch = steps.find((st) => st.name === "Fetch the archives");
    assert.equal(fetch?.with?.["name"], "archives");
    assert.equal(fetch?.with?.["path"], "dist");
    assert.equal(fetch?.if, undefined, "without the archives there is nothing to release");
    assert.ok(steps.indexOf(fetch!) < steps.findIndex((st) => st.run?.includes("gh release create")));
    assert.deepEqual(steps.filter((st) => /npm (ci|install|run build)/.test(st.run ?? "")).map((st) => st.name), [], "the publish job builds again");
  });
});

describe("the gate is not run twice for one tree", () => {
  const already = jobs["already-verified"];

  it("asks only on main, with read access to the runs and nothing else", () => {
    assert.equal(already.if, "${{ github.ref == 'refs/heads/main' }}");
    assert.deepEqual(already.permissions, { contents: "read", actions: "read" });
    const check = already.steps?.find((st) => st.id === "check");
    assert.equal(check?.run, "node --no-warnings scripts/verified-tree.ts");
    assert.equal(check?.env?.["GH_TOKEN"], "${{ github.token }}");
    assert.equal(already.steps?.find((st) => st.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"], 0, "the beta commit must be in the clone to compare with");
  });

  it("skips the gate only on a yes, and still runs it when the question was skipped or failed", () => {
    for (const name of ["verify-checks", "verify-tests"]) {
      assert.deepEqual(needsOf(jobs[name]), ["already-verified"]);
      assert.equal(jobs[name].if, "${{ !cancelled() && needs.already-verified.outputs.verified != 'true' }}", `${name} would be skipped with a skipped need`);
    }
  });

  it("releases on a passed gate or a yes, and on nothing else", () => {
    assert.equal(
      jobs["release"].if,
      "${{ !cancelled() && (needs.already-verified.outputs.verified == 'true' || (needs.verify-checks.result == 'success' && needs.verify-tests.result == 'success')) }}",
    );
  });
});
