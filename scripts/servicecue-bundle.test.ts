// servicecue-bundle.test.ts — build/servicecue/, the public page ready to upload.
//
// deploy.json says what to tell Cloudflare about the files beside it, and every value in it
// has a home somewhere else. The failure this guards is a copy that stopped following its
// original: a compatibility date raised in wrangler.jsonc and not here would upload a Worker
// the server then runs on a different runtime than `npm run servicecue:deploy` would.
//
// So this reads wrangler.jsonc by PARSING it (it is JSON with comments, and the build's own
// reader is not the one used here to expect it) and runs the real bundle, into a temporary
// folder. That the Worker module is what wrangler uploads is servicecue-bundle-wrangler.test.ts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PUBLISH_PROTOCOL_VERSION, VIEWER_HTML, viewerBuildFromHtml } from "../main/types/servicecue-publish.js";
import { CARRIED_KEYS, DEPLOYED_ELSEWHERE_KEYS, bundleServiceCue, deployManifest, parseWranglerConfig } from "./servicecue-bundle.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_TEXT = fs.readFileSync(path.join(ROOT, "publish/servicecue/wrangler.jsonc"), "utf8");

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "servicecue-bundle-"));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));
const bundled = await bundleServiceCue(OUT, true);

const written = JSON.parse(fs.readFileSync(path.join(OUT, "deploy.json"), "utf8")) as Record<string, unknown>;
const wrangler = parseWranglerConfig(WRANGLER_TEXT) as {
  compatibility_date: string;
  compatibility_flags?: string[];
  assets: Record<string, unknown> & { directory: string; binding: string };
  durable_objects: { bindings: { name: string; class_name: string }[] };
};

function filesUnder(dir: string, base = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(path.join(dir, e.name), rel) : [rel];
  });
}

describe("deploy.json, as the bundle wrote it", () => {
  test("carries wrangler.jsonc's compatibility date and flags", () => {
    assert.equal(written.compatibilityDate, wrangler.compatibility_date);
    assert.deepEqual(written.compatibilityFlags, wrangler.compatibility_flags ?? []);
  });

  test("carries wrangler.jsonc's asset rules, less where the files are and what the Worker calls them", () => {
    const { directory: _directory, binding: _binding, ...rules } = wrangler.assets;
    assert.deepEqual(written.assets, rules);
    assert.ok(Array.isArray((written.assets as { run_worker_first?: unknown }).run_worker_first), "run_worker_first is the rule that keeps the Worker in front of every path");
  });

  test("binds the assets and the Durable Object under the names the Worker reads them by", () => {
    assert.deepEqual(written.bindings, [
      { type: "assets", name: wrangler.assets.binding },
      ...wrangler.durable_objects.bindings.map((b) => ({ type: "durable_object_namespace", name: b.name, class_name: b.class_name })),
    ]);
  });

  test("names the build id stamped into the document it ships, the app's version and the protocol", () => {
    const document = fs.readFileSync(path.join(OUT, "public", VIEWER_HTML.slice(1)), "utf8");
    assert.equal(written.build, viewerBuildFromHtml(document));
    assert.match(String(written.build), /^[0-9a-f]{12}$/);
    assert.equal(written.version, (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version);
    assert.equal(written.protocol, PUBLISH_PROTOCOL_VERSION);
  });

  test("names a module that is in the folder and exports the handler and the Durable Object", () => {
    assert.equal(fs.existsSync(path.join(OUT, String(written.mainModule))), true);
    assert.deepEqual(bundled.workerExports, ["PublishHub", "default"]);
  });

  test("has exactly these fields", () => {
    assert.deepEqual(Object.keys(written).sort(), ["assets", "bindings", "build", "compatibilityDate", "compatibilityFlags", "mainModule", "protocol", "version"]);
  });
});

describe("the folder", () => {
  test("holds the Worker, the manifest and the page, and the page has its headers file", () => {
    const top = fs.readdirSync(OUT).sort();
    assert.deepEqual(top, ["deploy.json", "public", "worker.js"]);
    const page = filesUnder(path.join(OUT, "public"));
    assert.ok(page.includes("_headers") && page.includes("servicecue.html"));
  });
});

describe("deployManifest follows its sources", () => {
  const base = { wrangler: wrangler as unknown as Record<string, unknown>, version: "9.9.9", build: "abcdef012345" };

  test("a date, a flag, a binding and an asset rule changed in the config change the manifest", () => {
    const changed = {
      ...base.wrangler,
      compatibility_date: "2031-01-02",
      compatibility_flags: ["some_flag"],
      assets: { ...wrangler.assets, binding: "FILES", html_handling: "auto-trailing-slash" },
      durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
    };
    const m = deployManifest({ ...base, wrangler: changed });
    assert.equal(m.compatibilityDate, "2031-01-02");
    assert.deepEqual(m.compatibilityFlags, ["some_flag"]);
    assert.equal(m.assets.html_handling, "auto-trailing-slash");
    assert.deepEqual(m.bindings, [
      { type: "assets", name: "FILES" },
      { type: "durable_object_namespace", name: "ROOM", class_name: "Room" },
    ]);
    assert.equal(m.version, "9.9.9");
    assert.equal(m.build, "abcdef012345");
  });

  test("a key wrangler.jsonc gains that the manifest does not carry is an error, not a field that goes missing", () => {
    for (const key of ["kv_namespaces", "limits", "migrations", "routes", "triggers"]) {
      assert.throws(() => deployManifest({ ...base, wrangler: { ...base.wrangler, [key]: {} } }), new RegExp(`"${key}"`));
    }
  });

  test("vars become bindings: a string as plain text, anything else as JSON, in name order", () => {
    const m = deployManifest({ ...base, wrangler: { ...base.wrangler, vars: { MAX_VIEWERS: 500, GREETING: "hi", FLAGS: ["a"] } } });
    assert.deepEqual(m.bindings.slice(2), [
      { type: "json", name: "FLAGS", json: ["a"] },
      { type: "plain_text", name: "GREETING", text: "hi" },
      { type: "json", name: "MAX_VIEWERS", json: 500 },
    ]);
  });

  test("a binding to another Worker's class is an error: this upload does not carry one", () => {
    const foreign = { ...base.wrangler, durable_objects: { bindings: [{ name: "HUB", class_name: "PublishHub", script_name: "other" }] } };
    assert.throws(() => deployManifest({ ...base, wrangler: foreign }), /script_name/);
  });

  test("every key in the real wrangler.jsonc is one the manifest has decided about", () => {
    const known = new Set([...CARRIED_KEYS, ...DEPLOYED_ELSEWHERE_KEYS]);
    assert.deepEqual(Object.keys(wrangler).filter((k) => !known.has(k)), []);
  });

  test("the two lists of keys are sorted, one per line, and share none", () => {
    for (const list of [CARRIED_KEYS, DEPLOYED_ELSEWHERE_KEYS]) assert.deepEqual([...list], [...list].sort());
    assert.deepEqual(CARRIED_KEYS.filter((k) => DEPLOYED_ELSEWHERE_KEYS.includes(k)), []);
  });
});

describe("parseWranglerConfig", () => {
  test("reads comments and trailing commas, and refuses what is not JSON", () => {
    assert.deepEqual(parseWranglerConfig('{ // note\n "a": [1, 2,], /* b */ "c": "// not a comment" }'), { a: [1, 2], c: "// not a comment" });
    assert.throws(() => parseWranglerConfig("{ nope"), /could not be read/);
  });
});
