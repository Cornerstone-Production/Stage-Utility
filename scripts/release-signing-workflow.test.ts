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
}
const jobs = (parse(fs.readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, { steps?: Step[] }> }).jobs;

const KEY = testSigningKey();
const OTHER_KEY = testSigningKey(3072 + 64);

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
      assert.match(r.stderr, /^::error title=Release signing::the RELEASE_SIGNING_KEY secret is not set, so this release cannot be signed and is not published/m);
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
  const artifacts = jobs["artifacts"].steps ?? [];
  const SECRET = "${{ secrets.RELEASE_SIGNING_KEY }}";

  it("proves the signing key before it tags, on every run that releases", () => {
    const check = release.find((s) => s.run?.trim() === "scripts/sign-release-assets.sh --check");
    assert.ok(check, "no step runs sign-release-assets.sh --check");
    assert.equal(check.env?.["RELEASE_SIGNING_KEY"], SECRET);
    assert.equal(check.if, "steps.version.outputs.skip == 'false'", "the same condition as the push: a run that releases checks the key");
    const push = release.findIndex((s) => s.id === "push");
    assert.ok(release.indexOf(check) < push, "the key is checked before anything is pushed");
    // Its shell, for real: a missing secret stops it, and the right one passes.
    const missing = runStep(check, {});
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /::error title=Release signing::the RELEASE_SIGNING_KEY secret is not set/);
    const good = runStep(check, { RELEASE_SIGNING_KEY: KEY.privatePem });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  });

  it("hands the secret to the two signing steps and to nothing else", () => {
    const holders = Object.entries(jobs).flatMap(([job, j]) =>
      (j.steps ?? []).filter((s) => Object.values(s.env ?? {}).includes(SECRET)).map((s) => `${job}: ${s.name}`),
    );
    assert.deepEqual(holders.sort(), ["artifacts: Sign the update payloads", "release: Check the release signing key"]);
  });

  /** A step's shell, run in `tree` with the scripts it calls where the checkout has them. */
  function runStep(step: Step, env: Record<string, string>) {
    fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(tree, "scripts", "sign-release-assets.sh"));
    fs.chmodSync(path.join(tree, "scripts", "sign-release-assets.sh"), 0o755);
    return run(["-c", step.run!], env);
  }

  const signStep = artifacts.find((s) => s.name === "Sign the update payloads");
  const create = artifacts.find((s) => s.run?.includes("gh release create"));

  it("signs the launcher and the helper's zips after the zips are fetched and before the release is created", () => {
    assert.ok(signStep?.run && create?.run);
    const download = artifacts.findIndex((s) => s.uses?.startsWith("actions/download-artifact@"));
    assert.ok(download >= 0 && artifacts.indexOf(signStep) > download, "signed after the helper's zips are downloaded");
    assert.ok(artifacts.indexOf(signStep) < artifacts.indexOf(create), "signed before the release is created");
    assert.equal(signStep.if, undefined, "signing is not conditional");

    payload("scripts/kiosk/kiosk-windows.ps1", "Write-Output 'launcher'\r\n");
    payload("helper-dist/StageUtilityOutput-arm64.zip", "arm");
    payload("helper-dist/StageUtilityOutput-x86_64.zip", "x86");
    const r = runStep(signStep, { RELEASE_SIGNING_KEY: KEY.privatePem });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(path.join(tree, "sig-dist")).sort(), ["StageUtilityOutput-arm64.zip.sig", "StageUtilityOutput-x86_64.zip.sig", "kiosk-windows.ps1.sig"]);
    for (const [sig, file] of [["kiosk-windows.ps1.sig", "scripts/kiosk/kiosk-windows.ps1"], ["StageUtilityOutput-arm64.zip.sig", "helper-dist/StageUtilityOutput-arm64.zip"]]) {
      assert.ok(crypto.verify("sha256", fs.readFileSync(path.join(tree, file)), KEY.publicPem, fs.readFileSync(path.join(tree, "sig-dist", sig))), sig);
    }
  });

  it("signs the launcher alone when no helper was built", () => {
    payload("scripts/kiosk/kiosk-windows.ps1", "Write-Output 'launcher'\r\n");
    const r = runStep(signStep!, { RELEASE_SIGNING_KEY: KEY.privatePem });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(path.join(tree, "sig-dist")), ["kiosk-windows.ps1.sig"]);
  });

  it("fails the job when the secret is missing", () => {
    payload("scripts/kiosk/kiosk-windows.ps1", "x");
    const r = runStep(signStep!, {});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error title=Release signing::the RELEASE_SIGNING_KEY secret is not set/);
  });

  /** The create step's shell with `gh` and `node` stood in for; the files it attached. */
  function runCreate(populate: () => void): { status: number | null; err: string; attached: string[] } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "su-sign-bin-"));
    try {
      const log = path.join(tree, "gh.log");
      fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >>"$GH_LOG"; done\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      payload("dist/stage-utility-1.2.3-linux-x64.tar.gz", "x");
      populate();
      const script = create!.run!.replaceAll("/tmp/notes.md", path.join(tree, "notes.md"));
      const r = spawnSync("bash", ["-c", script], {
        cwd: tree,
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_LOG: log, GH_TOKEN: "x", V: "1.2.3", LAST: "v1.2.2", STABLE: "v1.2.0", PRE: "true" },
      });
      const args = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { status: r.status, err: r.stderr + r.stdout, attached: args.filter((a) => /^(dist|helper-dist|sig-dist)\//.test(a)).sort() };
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }

  it("attaches every signature the signing step made to the one release-create call", () => {
    const r = runCreate(() => {
      payload("helper-dist/StageUtilityOutput-arm64.zip", "a");
      payload("sig-dist/StageUtilityOutput-arm64.zip.sig", "s");
      payload("sig-dist/kiosk-windows.ps1.sig", "s");
    });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.attached, ["dist/stage-utility-1.2.3-linux-x64.tar.gz", "helper-dist/StageUtilityOutput-arm64.zip", "sig-dist/StageUtilityOutput-arm64.zip.sig", "sig-dist/kiosk-windows.ps1.sig"]);
  });

  it("does not create a release with no signatures", () => {
    const r = runCreate(() => undefined);
    assert.equal(r.status, 1);
    assert.match(r.err, /::error::no signatures in sig-dist, so v1\.2\.3 is not published unsigned/);
    assert.deepEqual(r.attached, [], "gh release create was never called");
  });
});
