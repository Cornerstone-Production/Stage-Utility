// The one-off deploy script, against a fake Cloudflare: it says each step, refuses the real
// Worker's name without being told to mean it, sends nothing on --check, and prints no secret.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { ACCOUNT_ID, API_TOKEN, FakeCloudflare, failure } from "../main/services/fixtures/fake-cloudflare.js";
import { BUILD_B, writeBundle, type WrittenBundle } from "../main/services/fixtures/deploy-bundle.js";
import { run } from "./servicecue-deploy-try.js";

let fake: FakeCloudflare;
let bundle: WrittenBundle;
before(async () => {
  fake = await FakeCloudflare.start();
});
after(() => fake.close());
beforeEach(() => {
  fake.reset();
  bundle = writeBundle();
});

const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: API_TOKEN };

async function go(args: string[], env: Record<string, string | undefined> = ENV): Promise<{ status: number; out: string }> {
  const lines: string[] = [];
  const status = await run([...args, "--bundle", bundle.dir, "--api", fake.origin], env, (l) => lines.push(l));
  bundle.remove();
  return { status, out: lines.join("\n") };
}

describe("servicecue-deploy-try", () => {
  test("deploys to a scratch Worker, says each step, and reads the version back", async () => {
    const { status, out } = await go(["--script", "scratch", "--version", "1.28.0"]);
    assert.equal(status, 0, out);
    for (const step of ["bundle     ", "target     Worker \"scratch\"", "verify     accepted", "deployed   build unknown", "files      6 to upload, 0 already on Cloudflare", "deploy     done: 6 uploaded, 0 already held", `deployed   now build ${BUILD_B}, version 1.28.0`]) {
      assert.ok(out.includes(step), `${step}\n${out}`);
    }
    assert.doesNotMatch(out, /WARNING/);
    assert.equal(fake.puts.length, 1);
    assert.ok(fake.requests.every((r) => r.path.includes("/scripts/scratch") || r.path.includes("/tokens/verify") || r.path.includes("/assets/upload")), "a request left the scratch Worker");
  });

  test("refuses the real Worker's name unless told it is meant, and sends nothing", async () => {
    const refused = await go(["--script", "servicecue"]);
    assert.equal(refused.status, 1);
    assert.match(refused.out, /FAILED +"servicecue" is the real Worker's name/);
    assert.equal(fake.requests.length, 0);
    bundle = writeBundle();
    const meant = await go(["--script", "servicecue", "--production"]);
    assert.equal(meant.status, 0, meant.out);
    assert.equal(fake.puts.length, 1);
  });

  test("--check verifies and reads, and sends no upload", async () => {
    const { status, out } = await go(["--script", "scratch", "--check"]);
    assert.equal(status, 0, out);
    assert.match(out, /check +nothing was sent/);
    assert.equal(fake.puts.length, 0);
    assert.equal(fake.to("POST", "/accounts").length, 0);
  });

  test("says when the version annotation does not come back, which the server depends on", async () => {
    fake.serveAnnotations = false;
    const { out } = await go(["--script", "scratch", "--version", "1.28.0"]);
    assert.match(out, /WARNING +Cloudflare reports build none, not bbbbbbbbbbbb/);
    assert.match(out, /WARNING +Cloudflare reports version none, not 1\.28\.0/);
  });

  test("says what Cloudflare refused, with its code, and exits 1", async () => {
    fake.respond = (r) => (r.method === "PUT" ? failure(403, 10000, "Authentication error") : undefined);
    const { status, out } = await go(["--script", "scratch"]);
    assert.equal(status, 1);
    assert.match(out, /FAILED +at "upload the Worker" \(HTTP 403, code 10000\): Authentication error/);
  });

  test("needs the account and the token from the environment, and a Worker", async () => {
    assert.match((await go(["--script", "scratch"], {})).out, /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required/);
    bundle = writeBundle();
    assert.match((await go([])).out, /--script .* is required/);
  });

  test("prints neither the token, a token Cloudflare handed back, nor the whole account id", async () => {
    fake.respond = (r) => (r.method === "PUT" ? failure(400, 10021, `saw ${API_TOKEN}`) : undefined);
    const failed = await go(["--script", "scratch"]);
    bundle = writeBundle();
    const worked = await go(["--script", "scratch"].concat([]), ENV);
    for (const out of [failed.out, worked.out]) {
      assert.doesNotMatch(out, new RegExp(API_TOKEN));
      assert.doesNotMatch(out, /\.sig\b/);
      assert.equal(out.includes(ACCOUNT_ID), false, "the whole account id was printed");
    }
  });

  test("only dials Cloudflare or this machine", async () => {
    const lines: string[] = [];
    const status = await run(["--script", "scratch", "--bundle", bundle.dir, "--api", "https://evil.example"], ENV, (l) => lines.push(l));
    bundle.remove();
    assert.equal(status, 1);
    assert.match(lines.join("\n"), /Cloudflare API address/);
  });
});
