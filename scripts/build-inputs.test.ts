// build-inputs.test.ts — which updated files make an update rebuild.
//
// An update skips `npm run build` unless a file the build reads changed. The list of those
// files was written by hand, and was short: a Worker-only change shipped a stale
// build/servicecue, and a probe found modules both pages import (main/services/clamp.ts,
// main/types/text-size.ts) and icons read from public/ that it did not name.
//
// So the list is held to what the builds actually read. This RUNS the operator app's build,
// the public page's build and the Worker's bundle, collects every module each one pulled in,
// adds the files the page's build reads by path, and asks each one of needsBuild. A file a
// build starts reading that the list does not cover fails here, by name. What the update
// scripts do with the answer is update-scripts.test.ts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { build as viteBuild, type Plugin } from "vite";

import { PUBLIC_STATIC_FILES } from "../main/types/servicecue-publish.js";
import { BUILD_INPUT_PREFIXES, needsBuild } from "./build-inputs.mjs";
import { bundleServiceCue } from "./servicecue-bundle.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "build-inputs-"));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const rel = (id: string): string | null => {
  const file = id.split("?")[0]!;
  return file.startsWith(`${ROOT}${path.sep}`) && !file.includes(`${path.sep}node_modules${path.sep}`) ? path.relative(ROOT, file).split(path.sep).join("/") : null;
};

/** Every module of one of the repo's vite builds, as repo-relative paths. */
async function viteInputs(configFile: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const collect: Plugin = {
    name: "collect-inputs",
    buildEnd() {
      for (const id of this.getModuleIds()) seen.add(id);
    },
  };
  await viteBuild({ root: ROOT, configFile: path.join(ROOT, configFile), logLevel: "silent", plugins: [collect], build: { outDir: path.join(SCRATCH, configFile), emptyOutDir: true } });
  const inputs = new Set<string>([configFile]);
  for (const id of seen) {
    const r = rel(id);
    if (r) inputs.add(r);
  }
  return inputs;
}

const operator = await viteInputs("vite.config.ts");
const page = await viteInputs("vite.servicecue.config.ts");
const worker = await bundleServiceCue(path.join(SCRATCH, "bundle"), true);

/** What the page's build reads by path and does not import (see viewerFiles in vite.servicecue.config.ts). */
const READ_BY_PATH = PUBLIC_STATIC_FILES.map((f) => `public${f}`).filter((f) => fs.existsSync(path.join(ROOT, f)));

/** Files under public/ that vite.config.ts copies into the interface whole. */
function filesUnder(dir: string, base: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(`${dir}/${e.name}`, `${base}${e.name}/`) : [`${dir}/${e.name}`]));
}

describe("everything a build reads is a build input", () => {
  const sets: [string, string[]][] = [
    ["the operator app's build", [...operator]],
    ["the public page's build", [...page]],
    ["the Worker's bundle", worker.workerInputs.map((p) => path.relative(ROOT, path.join(ROOT, "publish/servicecue", p)).split(path.sep).join("/")).filter((p) => !p.includes("node_modules"))],
    ["the files the page's build reads by path", READ_BY_PATH],
    ["the files the interface's build copies from public/", filesUnder("public", "")],
    ["the documents the builds start from", ["index.html", "app.html", "servicecue.html"]],
  ];

  for (const [what, files] of sets) {
    test(what, () => {
      assert.ok(files.length >= 3, `${what} found only ${files.length} files: the collector is not collecting`);
      assert.deepEqual(files.filter((f) => !needsBuild([f])), []);
    });
  }

  test("and the collectors saw what they should: both pages' shared modules, and the page's own files", () => {
    for (const shared of ["main/services/clamp.ts", "main/types/text-size.ts"]) assert.ok(page.has(shared), `the page's build no longer reads ${shared}: this test is not looking where it was`);
    assert.ok(page.has("renderer/app/servicecue-routes.tsx"));
    assert.ok(operator.has("renderer/app/shell.tsx"));
    assert.ok(READ_BY_PATH.includes("public/favicon.svg"));
    assert.ok(worker.workerInputs.some((p) => p.endsWith("src/hub.ts")));
  });
});

describe("what does not make an update rebuild", () => {
  test("docs, the repository's notes, the Worker's tests and notes, helper apps and the update scripts", () => {
    for (const p of [
      "docs/ops/servicecue-on-the-web.md",
      "README.md",
      "CLAUDE.md",
      "publish/servicecue/README.md",
      "publish/servicecue/test/worker.integration.test.mjs",
      "scripts/update.sh",
      "scripts/update.ps1",
      "scripts/build-inputs.mjs",
      "helper/macos/Package.swift",
      ".github/workflows/ci.yml",
    ]) {
      assert.equal(needsBuild([p]), false, p);
    }
  });

  test("the list is sorted, one per line", () => {
    assert.deepEqual([...BUILD_INPUT_PREFIXES], [...BUILD_INPUT_PREFIXES].sort());
  });
});
