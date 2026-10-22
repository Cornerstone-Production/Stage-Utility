// servicecue-bundle-wrangler.test.ts — the bundle is what `wrangler deploy` would upload.
//
// build/servicecue/ stands in for a wrangler deploy, so it is held to wrangler's own: this
// runs `wrangler deploy --dry-run` (no login, no network, nothing sent) on the Worker, with the
// bundle's page as its assets, and compares what each produced.
//
//   - the Worker module, byte for byte (less the source map comment wrangler adds);
//   - what that module exports and the source files it was bundled from;
//   - the bindings wrangler reports, and how many files it read as the page.
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

describe("the bundle against wrangler deploy --dry-run", { skip: present || required ? false : "wrangler is not installed (npm --prefix publish/servicecue ci)" }, () => {
  test("is the same Worker, the same bindings and the same page", async () => {
    assert.equal(present, true, "SERVICECUE_REQUIRE_WRANGLER is set and wrangler is not installed in publish/servicecue");
    const ours = await bundleServiceCue(path.join(SCRATCH, "bundle"), true);

    const theirs = path.join(SCRATCH, "wrangler");
    const metafile = path.join(SCRATCH, "wrangler-meta.json");
    const run = spawnSync(WRANGLER, ["deploy", "--dry-run", "--outdir", theirs, "--metafile", metafile, "--assets", path.join(ours.outDir, "public")], {
      cwd: WORKER,
      encoding: "utf8",
      // No account and no telemetry: nothing here talks to Cloudflare.
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    });
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

    // The page: every entry in the folder, `_headers` included. wrangler's count takes in a
    // folder as it does a file (`assets/`), so a folder counts too.
    const entries = (dir: string): number =>
      fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + 1 + (e.isDirectory() ? entries(path.join(dir, e.name)) : 0), 0);
    assert.equal(/Read (\d+) files? from the assets directory/.exec(run.stdout)?.[1], String(entries(path.join(ours.outDir, "public"))));
  });
});
