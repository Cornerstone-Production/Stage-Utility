// servicecue-bundle-wrangler.test.ts — the bundle is what `wrangler deploy` would upload.
//
// build/servicecue/ stands in for a wrangler deploy, so it is held to wrangler's own: this
// runs `wrangler deploy --dry-run` (no login, no network, nothing sent) on the Worker, with the
// bundle's page as its assets, and compares what each produced.
//
//   - the Worker module, byte for byte (less the source map comment wrangler adds);
//   - what that module exports and the source files it was bundled from;
//   - the bindings wrangler reports, and the files it reads from the bundle's page (and that
//     `_headers` is config to it, which is why deploy.json carries its text).
//
// The compatibility date, flags and asset rules are not in a dry run's output: wrangler reads
// them from wrangler.jsonc and so does the manifest, and servicecue-bundle.test.ts holds the
// manifest to the file.
//
// It needs the Worker package's dependencies, which the root suite does not install, so it
// skips where wrangler is not there and says so. The `worker` job in ci.yml installs both and
// sets SERVICECUE_REQUIRE_WRANGLER, which turns that skip into a failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";

import { bundleServiceCue } from "./servicecue-bundle.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "publish/servicecue");
const WRANGLER = path.join(WORKER, "node_modules/.bin/wrangler");
const present = fs.existsSync(WRANGLER);
const required = process.env.SERVICECUE_REQUIRE_WRANGLER === "1";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "servicecue-wrangler-"));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** `wrangler deploy --dry-run` of the Worker with `assets` as its page. */
function dryRun(outdir: string, assets: string, metafile?: string) {
  return spawnSync(WRANGLER, ["deploy", "--dry-run", "--outdir", outdir, ...(metafile ? ["--metafile", metafile] : []), "--assets", assets], {
    cwd: WORKER,
    encoding: "utf8",
    // No account and no telemetry: nothing here talks to Cloudflare. Debug logging is what lists the files it read.
    env: { ...process.env, WRANGLER_LOG: "debug", WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
  });
}

/** The files wrangler lists after "Read N files from the assets directory": its lines that start with "/", less the folders among them. */
function listedFiles(output: string): string[] {
  const after = output.slice(output.indexOf("from the assets directory"));
  const entries = after.split("\n").filter((l) => /^\/\S+$/.test(l.trim())).map((l) => l.trim());
  return entries.filter((e) => !entries.some((o) => o.startsWith(`${e}/`))).sort();
}

function filesUnder(dir: string, base = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]));
}

describe("the bundle against wrangler deploy --dry-run", { skip: present || required ? false : "wrangler is not installed (npm --prefix publish/servicecue ci)" }, () => {
  test("is the same Worker, the same bindings and the same page", async () => {
    assert.equal(present, true, "SERVICECUE_REQUIRE_WRANGLER is set and wrangler is not installed in publish/servicecue");
    const ours = await bundleServiceCue(path.join(SCRATCH, "bundle"), true);

    const theirs = path.join(SCRATCH, "wrangler");
    const metafile = path.join(SCRATCH, "wrangler-meta.json");
    const run = dryRun(theirs, path.join(ours.outDir, "public"), metafile);
    assert.equal(run.status, 0, `wrangler: ${run.stdout}${run.stderr}`);

    // The module.
    const stripMap = (code: string) => code.replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n");
    assert.equal(
      fs.readFileSync(path.join(ours.outDir, ours.manifest.mainModule), "utf8"),
      stripMap(fs.readFileSync(path.join(theirs, "worker.js"), "utf8")),
      "the bundled Worker differs from the module wrangler would upload: see WORKER_BUNDLE_OPTIONS in scripts/servicecue-bundle.ts",
    );
    const meta = JSON.parse(fs.readFileSync(metafile, "utf8")) as { inputs: Record<string, unknown> };
    // wrangler's metafile is of an earlier step and lists no exports; the module it wrote does.
    const theirModule = await esbuild({ entryPoints: [path.join(theirs, "worker.js")], format: "esm", write: false, metafile: true, logLevel: "silent" });
    assert.deepEqual([...Object.values(theirModule.metafile.outputs)[0]!.exports].sort(), ours.workerExports);
    assert.deepEqual(Object.keys(meta.inputs).sort(), ours.workerInputs);

    // The bindings wrangler lists, as `env.NAME (Class)  Kind`.
    const listed = [...run.stdout.matchAll(/^env\.(\w+)(?: \((\w+)\))?\s+(Durable Object|Assets)\s*$/gm)].map((m) =>
      m[3] === "Assets" ? `assets ${m[1]}` : `durable_object_namespace ${m[1]} ${m[2]}`,
    );
    // Variables are listed as a different kind of row and are the config's own: the manifest
    // test covers them.
    const declared = ours.manifest.bindings.flatMap((b) =>
      b.type === "assets" ? [`assets ${b.name}`] : b.type === "durable_object_namespace" ? [`${b.type} ${b.name} ${b.class_name}`] : [],
    );
    assert.deepEqual(listed.sort(), declared.sort());

    // The page: the files wrangler reads from our folder are the files in it, and `_headers`,
    // which is not among them, is the one file wrangler reads as config and does not upload.
    const files = listedFiles(run.stdout + run.stderr);
    assert.deepEqual(files, filesUnder(path.join(ours.outDir, "public")).map((f) => `/${f}`).sort());
    assert.equal(files.includes("/_headers"), false);

    const withHeaders = path.join(SCRATCH, "with-headers");
    fs.cpSync(path.join(ours.outDir, "public"), withHeaders, { recursive: true });
    fs.writeFileSync(path.join(withHeaders, "_headers"), String(ours.manifest.assets._headers));
    const second = dryRun(path.join(SCRATCH, "wrangler-2"), withHeaders);
    assert.match(second.stdout + second.stderr, /Ignoring asset: _headers/, "wrangler uploads _headers as an asset after all: deploy.json's assets._headers is wrong");
  });
});
