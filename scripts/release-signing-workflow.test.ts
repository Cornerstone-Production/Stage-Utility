// The release signs every payload a machine updates itself from, and refuses to
// publish unsigned.
//
// scripts/sign-release-assets.sh is run for real, with a key pair made for this
// run standing in for the RELEASE_SIGNING_KEY secret and the committed public key,
// and its signatures are checked with openssl and with Node. The workflow is
// parsed, not searched: the signing steps' own shell is run on a temporary tree,
// and the release-create step's shell with `gh` stood in for, so a step that stops
// signing, stops attaching the signatures, or publishes without them goes red.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { testSigningKey } from "../main/services/fixtures/test-signing-key.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SCRIPT = path.join(HERE, "sign-release-assets.sh");
const WORKFLOW = path.join(REPO, ".github", "workflows", "release.yml");

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
}
const doc = parse(fs.readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, Job> };
const jobs = doc.jobs;
/** A step as the allowlists name it: its name, the action it uses (without the
 *  pinned version, which Dependabot moves), or both. */
const stepId = (s: Step): string => {
  const action = s.uses ? `uses ${s.uses.split("@")[0]}` : "";
  return s.name ? (action ? `${s.name} (${action})` : s.name) : action;
};
const needsOf = (j: Job): string[] => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);

const KEY = testSigningKey();
const OTHER_KEY = testSigningKey(3072, "other");

let tree: string;
let tmp: string;
beforeEach(() => {
  tree = fs.mkdtempSync(path.join(os.tmpdir(), "su-sign-"));
  // The script's own temporary folder goes here, so a test can see it is gone.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "su-sign-tmp-"));
});
afterEach(() => {
  fs.rmSync(tree, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run `script` (a file or a step's shell) in `tree`, as a runner would. */
function run(args: string[], env: Record<string, string>, cmd = "bash") {
  return spawnSync(cmd, args, {
    cwd: tree,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", TMPDIR: tmp, SIGN_TEST_PUBLIC_KEY: KEY.publicFile(), ...env },
  });
}
const sign = (args: string[], env: Record<string, string> = { RELEASE_SIGNING_KEY: KEY.privatePem }) => run([SCRIPT, ...args], env);

function payload(name: string, bytes: Buffer | string): string {
  const file = path.join(tree, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

describe("sign-release-assets.sh", () => {
  it("writes <name>.sig for each file, which the public key verifies with openssl and with Node", () => {
    const zip = payload("helper-dist/StageUtilityOutput-arm64.zip", crypto.randomBytes(50_000));
    const ps1 = payload("scripts/kiosk/kiosk-windows.ps1", "Write-Output 'launcher'\r\n");
    const r = sign(["sig-dist", zip, ps1]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(path.join(tree, "sig-dist")).sort(), ["StageUtilityOutput-arm64.zip.sig", "kiosk-windows.ps1.sig"]);
    for (const file of [zip, ps1]) {
      const sig = path.join(tree, "sig-dist", `${path.basename(file)}.sig`);
      assert.equal(fs.statSync(sig).size, 384, "an RSA-3072 signature");
      assert.equal(crypto.verify("sha256", fs.readFileSync(file), KEY.publicPem, fs.readFileSync(sig)), true);
      const v = spawnSync("openssl", ["dgst", "-sha256", "-verify", KEY.publicFile(), "-signature", sig, file], { encoding: "utf8" });
      assert.equal(v.status, 0, v.stdout + v.stderr);
    }
    assert.deepEqual(fs.readdirSync(tmp), [], "the key's temporary copy is removed");
  });

  it("with the macOS openssl too, which is what the Mac updater verifies with", { skip: !fs.existsSync("/usr/bin/openssl") && "no /usr/bin/openssl" }, () => {
    const zip = payload("StageUtilityOutput-x86_64.zip", crypto.randomBytes(10_000));
    assert.equal(sign(["sig-dist", zip]).status, 0);
    const v = spawnSync("/usr/bin/openssl", ["dgst", "-sha256", "-verify", KEY.publicFile(), "-signature", path.join(tree, "sig-dist", "StageUtilityOutput-x86_64.zip.sig"), zip], { encoding: "utf8" });
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /Verified OK/);
  });

  it("fails loudly, and signs nothing, when the secret is not set", () => {
    const zip = payload("StageUtilityOutput-arm64.zip", "zip");
    for (const env of [{}, { RELEASE_SIGNING_KEY: "" }]) {
      const r = sign(["sig-dist", zip], env);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^::error title=Release signing::the RELEASE_SIGNING_KEY secret is not set, so this release cannot be signed\./m);
      assert.ok(!fs.existsSync(path.join(tree, "sig-dist")));
    }
  });

  it("fails when the secret is not the private half of the committed public key", () => {
    const zip = payload("StageUtilityOutput-arm64.zip", "zip");
    const r = sign(["sig-dist", zip], { RELEASE_SIGNING_KEY: OTHER_KEY.privatePem });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not verify against .*: RELEASE_SIGNING_KEY is not the private half of the committed public key/);
  });

  it("fails when the secret is not a private key", () => {
    const r = sign(["--check"], { RELEASE_SIGNING_KEY: KEY.publicPem });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /RELEASE_SIGNING_KEY is not a PEM private key/);
  });

  it("fails when the committed public key is the placeholder", () => {
    const placeholder = payload("release-signing.pub.pem", "PLACEHOLDER: the production release signing public key goes here.\n");
    const r = run([SCRIPT, "--check"], { RELEASE_SIGNING_KEY: KEY.privatePem, SIGN_TEST_PUBLIC_KEY: placeholder });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not a public key openssl can read \(is it still the placeholder\?\)/);
  });

  it("--check proves the key and writes nothing", () => {
    const r = sign(["--check"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(tree), []);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("refuses a payload that is not there, and two payloads with one name", () => {
    assert.match(sign(["sig-dist", path.join(tree, "missing.zip")]).stderr, /missing\.zip is not a file/);
    const a = payload("a/x.zip", "a");
    const b = payload("b/x.zip", "b");
    const r = sign(["sig-dist", a, b]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /x\.zip\.sig exists already/);
  });
});

describe("release.yml", () => {
  const release = jobs["release"].steps ?? [];
  const sign = jobs["sign"]?.steps ?? [];
  const artifacts = jobs["artifacts"].steps ?? [];
  const SECRET = "secrets.RELEASE_SIGNING_KEY";

  /** Every place in the workflow, at any level, whose text names the secret. */
  function secretHolders(node: unknown, at: string[] = []): string[] {
    if (typeof node === "string") return node.includes(SECRET) ? [at.join(".")] : [];
    if (Array.isArray(node)) return node.flatMap((v, i) => secretHolders(v, [...at, (v as Step)?.name ?? String(i)]));
    if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => secretHolders(v, [...at, k]));
    return [];
  }

  it("hands the secret to two steps' env and to nothing else: no workflow, job or other step env, no input, no script", () => {
    assert.deepEqual(secretHolders(doc).sort(), [
      "jobs.release.steps.Check the release signing key.env.RELEASE_SIGNING_KEY",
      "jobs.sign.steps.Sign the update payloads.env.RELEASE_SIGNING_KEY",
    ]);
  });

  it("proves the signing key before it tags, on every run that releases, with only the listed steps before it", () => {
    const check = release.find((s) => s.run?.trim() === "scripts/sign-release-assets.sh --check");
    assert.ok(check, "no step runs sign-release-assets.sh --check");
    assert.equal(check.if, "steps.version.outputs.skip == 'false'", "the same condition as the push: a run that releases checks the key");
    const at = release.indexOf(check);
    assert.ok(at < release.findIndex((s) => s.id === "push"), "the key is checked before anything is pushed");
    // An allowlist, not a search for npm: any step added before the check, by
    // whatever means it installs or runs code, has to be added here on purpose.
    assert.deepEqual(release.slice(0, at + 1).map(stepId), [
      "uses actions/checkout",
      "Set up Node (uses actions/setup-node)",
      "Mark the verified commit",
      "Decide the version",
      "Check the release signing key",
    ]);
    // Its shell, for real: a missing secret stops it, and the right one passes.
    const missing = runStep(check, {});
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /::error title=Release signing::the RELEASE_SIGNING_KEY secret is not set/);
    const good = runStep(check, { RELEASE_SIGNING_KEY: KEY.privatePem });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  });

  it("signs in a job of its own that installs and runs nothing it does not list", () => {
    assert.ok(jobs["sign"], "no sign job");
    assert.deepEqual(needsOf(jobs["sign"]).sort(), ["helper", "release"]);
    assert.ok((jobs["sign"].if ?? "").includes("always()") && (jobs["sign"].if ?? "").includes("needs.release.outputs.published == 'true'"));
    // Exactly these steps, and the signing step runs exactly these commands.
    assert.deepEqual(sign.map(stepId), [
      "uses actions/checkout",
      "Fetch the Mac output helper (uses actions/download-artifact)",
      "Sign the update payloads",
      "uses actions/upload-artifact",
    ]);
    const commands = (signStep?.run ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/[\s(=]/)[0]);
    assert.deepEqual([...new Set(commands)].sort(), ["git", "if", "mkdir", "payloads", "scripts/sign-release-assets.sh", "set"]);
    const checkout = sign.find((s) => s.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout?.with?.["ref"], "v${{ needs.release.outputs.version }}");
    assert.equal(checkout?.with?.["persist-credentials"], false);
  });

  /** A tree that is a git repository with the launcher tagged v1.2.3, and the scripts the steps call. */
  function tagged(launcher: Buffer): void {
    payload("scripts/kiosk/kiosk-windows.ps1", launcher);
    fs.copyFileSync(KEY.publicFile(), path.join(tree, "scripts", "kiosk", "release-signing.pub.pem"));
    const g = (args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: tree, encoding: "utf8" });
    for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "v"], ["tag", "v1.2.3"]]) assert.equal(g(args).status, 0, args.join(" "));
  }

  /** A step's shell, run in `tree` with the signing script where the checkout has it. */
  function runStep(step: Step, env: Record<string, string>) {
    fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(tree, "scripts", "sign-release-assets.sh"));
    fs.chmodSync(path.join(tree, "scripts", "sign-release-assets.sh"), 0o755);
    return run(["-c", step.run!], { V: "1.2.3", RUNNER_TEMP: tmp, ...env });
  }

  const signStep = sign.find((s) => s.name === "Sign the update payloads");
  const create = artifacts.find((s) => s.run?.includes("gh release create"));
  const LAUNCHER = Buffer.from("Write-Output 'launcher'\n");

  it("signs the tagged launcher, not the workspace's, and the helper's zips after they are fetched", () => {
    assert.ok(signStep?.run);
    const download = sign.findIndex((s) => s.uses?.startsWith("actions/download-artifact@"));
    assert.ok(download >= 0 && sign.indexOf(signStep) > download, "signed after the helper's zips are downloaded");
    assert.equal(sign[download].if, "${{ needs.helper.result == 'success' }}");
    tagged(LAUNCHER);
    // The workspace differs from the tag: what is signed must be the tag's.
    fs.writeFileSync(path.join(tree, "scripts", "kiosk", "kiosk-windows.ps1"), "Write-Output 'changed after the tag'\r\n");
    payload("helper-dist/StageUtilityOutput-arm64.zip", "arm");
    payload("helper-dist/StageUtilityOutput-x86_64.zip", "x86");
    const r = runStep(signStep, { RELEASE_SIGNING_KEY: KEY.privatePem });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(path.join(tree, "sig-dist")).sort(), ["StageUtilityOutput-arm64.zip.sig", "StageUtilityOutput-x86_64.zip.sig", "kiosk-windows.ps1.sig"]);
    assert.ok(crypto.verify("sha256", LAUNCHER, KEY.publicPem, fs.readFileSync(path.join(tree, "sig-dist", "kiosk-windows.ps1.sig"))), "the tagged launcher's signature");
    assert.ok(crypto.verify("sha256", Buffer.from("arm"), KEY.publicPem, fs.readFileSync(path.join(tree, "sig-dist", "StageUtilityOutput-arm64.zip.sig"))));
  });

  it("signs the launcher alone when no helper was built, and fails without the secret", () => {
    tagged(LAUNCHER);
    const r = runStep(signStep!, { RELEASE_SIGNING_KEY: KEY.privatePem });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(path.join(tree, "sig-dist")), ["kiosk-windows.ps1.sig"]);
    fs.rmSync(path.join(tree, "sig-dist"), { recursive: true });
    const missing = runStep(signStep!, {});
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /the RELEASE_SIGNING_KEY secret is not set/);
  });

  it("hands its signatures to the artifacts job, which waits for it and fetches them only from a sign job that succeeded", () => {
    const upload = sign.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    const fetchSigs = artifacts.find((s) => s.name === "Fetch the release signatures");
    assert.ok(upload && fetchSigs);
    assert.equal(fetchSigs.with?.["name"], upload.with?.["name"]);
    assert.equal(fetchSigs.with?.["path"], "sig-dist");
    assert.equal(fetchSigs.if, "${{ needs.sign.result == 'success' }}");
    assert.ok(needsOf(jobs["artifacts"]).includes("sign"));
    assert.ok(artifacts.indexOf(fetchSigs) < artifacts.indexOf(create!));
  });

  /** The create step's shell with `gh` stood in for; the files it attached and what it said. */
  function runCreate(populate: () => void): { status: number | null; err: string; attached: string[] } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "su-sign-bin-"));
    try {
      const log = path.join(tree, "gh.log");
      fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >>"$GH_LOG"; done\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      tagged(LAUNCHER);
      // The workspace differs from the tag: the set must verify against the tag's.
      fs.writeFileSync(path.join(tree, "scripts", "kiosk", "kiosk-windows.ps1"), "Write-Output 'changed after the tag'\r\n");
      payload("dist/stage-utility-1.2.3-linux-x64.tar.gz", "x");
      populate();
      const script = create!.run!.replaceAll("/tmp/notes.md", path.join(tree, "notes.md"));
      const r = spawnSync("bash", ["-c", script], {
        cwd: tree,
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_LOG: log, GH_TOKEN: "x", V: "1.2.3", LAST: "v1.2.2", STABLE: "v1.2.0", PRE: "true", RUNNER_TEMP: tmp },
      });
      const args = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { status: r.status, err: r.stderr + r.stdout, attached: args.filter((a) => /^(dist|helper-dist|sig-dist)\//.test(a)).sort() };
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }
  const sigOf = (name: string, bytes: Buffer | string, key = KEY) => payload(`sig-dist/${name}.sig`, key.sign(bytes));
  const UNSIGNED = /::error title=Release signing::v1\.2\.3 is published WITHOUT signatures: (.+)\. Every Mac helper and Windows kiosk refuses an unsigned update/;

  it("attaches a whole set that verifies to the one release-create call", () => {
    const r = runCreate(() => {
      payload("helper-dist/StageUtilityOutput-arm64.zip", "a");
      sigOf("StageUtilityOutput-arm64.zip", "a");
      sigOf("kiosk-windows.ps1", LAUNCHER);
    });
    assert.equal(r.status, 0, r.err);
    assert.doesNotMatch(r.err, /WITHOUT signatures/);
    assert.deepEqual(r.attached, ["dist/stage-utility-1.2.3-linux-x64.tar.gz", "helper-dist/StageUtilityOutput-arm64.zip", "sig-dist/StageUtilityOutput-arm64.zip.sig", "sig-dist/kiosk-windows.ps1.sig"]);
  });

  for (const [label, populate, why] of [
    ["no signatures, as after a sign job that failed", () => payload("helper-dist/StageUtilityOutput-arm64.zip", "a"), /the sign job left 0 signature\(s\) for 2 payload\(s\)/],
    ["a set missing the helper's", () => {
      payload("helper-dist/StageUtilityOutput-arm64.zip", "a");
      sigOf("kiosk-windows.ps1", LAUNCHER);
    }, /left 1 signature\(s\) for 2 payload\(s\)/],
    ["a signature by another key", () => sigOf("kiosk-windows.ps1", LAUNCHER, OTHER_KEY), /sig-dist\/kiosk-windows\.ps1\.sig is missing or does not verify/],
    ["a signature of other bytes", () => sigOf("kiosk-windows.ps1", "Write-Output 'not the tagged one'\n"), /does not verify/],
  ] as const) {
    it(`still publishes the archives, with no signature attached and an error, for ${label}`, () => {
      const r = runCreate(populate);
      assert.equal(r.status, 0, r.err);
      assert.match(r.err, UNSIGNED);
      assert.match(UNSIGNED.exec(r.err)?.[1] ?? "", why);
      assert.ok(r.attached.includes("dist/stage-utility-1.2.3-linux-x64.tar.gz"), "the archives are published");
      assert.deepEqual(r.attached.filter((a) => a.startsWith("sig-dist/")), [], "no partial or mismatched set is attached");
    });
  }
});
