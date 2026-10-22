// build-inputs.test.ts — which updated files make an update rebuild.
//
// An update skips `npm run build` unless a file the build reads changed. When the public
// ServiceCue page's Worker was not on that list, a Worker-only update shipped a stale
// build/servicecue. The rule runs here as the update scripts run it: update.sh's own line,
// executed under bash against a list of changed paths, and the node script both scripts call.
// update.ps1 calls the same script (PowerShell is not run on this host).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { BUILD_INPUT_PREFIXES, needsBuild } from "./build-inputs.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS, "..");

const REBUILDS = [
  "renderer/app/shell.tsx",
  "publish/servicecue/src/hub.ts",
  "publish/servicecue/wrangler.jsonc",
  "servicecue.html",
  "vite.servicecue.config.ts",
  "main/types/servicecue-publish.ts",
  "scripts/servicecue-bundle.ts",
  "tsconfig.json",
];
const SKIPS = ["docs/ops/servicecue-on-the-web.md", "README.md", "main/services/updater.ts", "publish/servicecue/README.md", "publish/servicecue/test/worker.integration.test.mjs", "main/types/servicecue-publish.test.ts"];

/** update.sh's own decision line, run with NEED_BUILD=0 and the given change list. */
function shDecides(changed: string[]): boolean {
  const line = fs.readFileSync(path.join(SCRIPTS, "update.sh"), "utf8").split("\n").find((l) => l.includes("build-inputs.mjs") && l.includes("NEED_BUILD=1"));
  assert.ok(line, "update.sh no longer asks build-inputs.mjs");
  const r = spawnSync("bash", ["-c", `NEED_BUILD=0; ${line}; echo $NEED_BUILD`], { encoding: "utf8", env: { ...process.env, REPO, CHANGED: changed.join("\n") } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() === "1";
}

describe("what makes an update rebuild", () => {
  test("a change to the interface, the Worker, its config, the page's document or the contract does", () => {
    for (const p of REBUILDS) {
      assert.equal(needsBuild([p]), true, p);
      assert.equal(shDecides(["docs/x.md", p]), true, `update.sh: ${p}`);
    }
  });

  test("a change to docs, the updater or the Worker's own tests and notes does not", () => {
    for (const p of SKIPS) {
      assert.equal(needsBuild([p]), false, p);
      assert.equal(shDecides([p]), false, `update.sh: ${p}`);
    }
    assert.equal(shDecides([]), false);
  });

  test("an unreadable list rebuilds", () => {
    const r = spawnSync("bash", ["-c", `NEED_BUILD=0; ${fs.readFileSync(path.join(SCRIPTS, "update.sh"), "utf8").split("\n").find((l) => l.includes("build-inputs.mjs") && l.includes("NEED_BUILD=1"))}; echo $NEED_BUILD`], {
      encoding: "utf8",
      env: { ...process.env, REPO: path.join(REPO, "nowhere"), CHANGED: "docs/x.md" },
    });
    assert.equal(r.stdout.trim(), "1", "a script that could not run was read as nothing changed");
  });

  test("the list is sorted, one per line", () => {
    assert.deepEqual([...BUILD_INPUT_PREFIXES], [...BUILD_INPUT_PREFIXES].sort());
  });

  test("both update scripts decide through this one list", () => {
    for (const script of ["update.sh", "update.ps1"]) {
      assert.match(fs.readFileSync(path.join(SCRIPTS, script), "utf8"), /build-inputs\.mjs/, script);
    }
  });
});
