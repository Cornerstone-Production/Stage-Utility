// servicecue-bundle-soft.test.ts — `npm run build` never stops on the page's bundle.
//
// The build runs the bundle with --soft so that an update on a box that cannot make it (a
// config the bundle cannot describe, a dependency it cannot load) still updates the app. That
// is a promise about the command, so this runs the command: exit 0, one tagged line saying
// why, and no half-written folder for a deployer to find. Without --soft the same failure
// exits 1, which is what a release archive relies on.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const COMMAND = path.join(SCRIPTS, "servicecue-bundle.ts");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "servicecue-soft-"));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** Run the command with a wrangler.jsonc it cannot describe, over a folder an earlier run left. */
function run(args: string[], opts: { blockModule?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "run-"));
  const out = path.join(dir, "servicecue");
  fs.mkdirSync(path.join(out, "public"), { recursive: true });
  fs.writeFileSync(path.join(out, "deploy.json"), "{}");
  const config = path.join(dir, "wrangler.jsonc");
  fs.writeFileSync(config, '{ "name": "x", "kv_namespaces": [] }');

  const node = ["--import", "tsx"];
  if (opts.blockModule) {
    // A resolve hook that refuses one package, as a box without it would.
    const hooks = path.join(dir, "hooks.mjs");
    fs.writeFileSync(hooks, `export async function resolve(s, c, next) { if (s === ${JSON.stringify(opts.blockModule)}) throw new Error("Cannot find package '" + s + "'"); return next(s, c); }\n`);
    const register = `import { register } from "node:module"; register(${JSON.stringify(`file://${hooks}`)});`;
    node.push("--import", `data:text/javascript,${encodeURIComponent(register)}`);
  }
  const r = spawnSync(process.execPath, [...node, COMMAND, ...args], {
    encoding: "utf8",
    env: { ...process.env, SERVICECUE_BUNDLE_OUT: out, SERVICECUE_BUNDLE_WRANGLER: opts.blockModule ? path.join(SCRIPTS, "../publish/servicecue/wrangler.jsonc") : config },
  });
  return { status: r.status, stderr: r.stderr, left: fs.existsSync(out) };
}

describe("the bundle command", () => {
  test("--soft: a config it cannot describe is exit 0, one tagged line with the reason, and no folder", () => {
    const r = run(["--soft"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[servicecue-bundle\] FAILED, so this server cannot update the public ServiceCue page.*kv_namespaces/);
    assert.equal(r.left, false, "a folder from before, or half of this run's, is still there");
  });

  test("--soft: a dependency that will not load is the same", () => {
    const r = run(["--soft"], { blockModule: "typescript" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[servicecue-bundle\] FAILED, so this server cannot update.*typescript/);
    assert.equal(r.left, false);
  });

  test("without --soft the same failures exit 1 and leave no folder", () => {
    for (const r of [run([]), run([], { blockModule: "typescript" })]) {
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /\[servicecue-bundle\] FAILED: /);
      assert.equal(r.left, false);
    }
  });
});
