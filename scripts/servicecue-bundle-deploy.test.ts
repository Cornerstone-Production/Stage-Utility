// servicecue-bundle-deploy.test.ts — what the bundle writes is what the deployer uploads.
//
// The deployer (main/services/servicecue-cloudflare.ts) reads build/servicecue/ and sends it to
// Cloudflare; the bundle (servicecue-bundle.ts) writes it. Each is tested alone, with a folder
// one wrote by hand. This runs both on the REAL bundle, against a fake Cloudflare: every file of
// the page is registered and uploaded, the metadata is deploy.json's, and the failure marker the
// bundle leaves is the one the deployer reads.
//
// And wrangler's own hashing: the deployer says a file by the same hash wrangler does, so what a
// `npm run servicecue:deploy` already put on the Worker is not uploaded twice. blake3-wasm is the
// library wrangler hashes with; it is in publish/servicecue/node_modules, which the root suite
// does not install, so that part skips where it is not and SERVICECUE_REQUIRE_WRANGLER turns the
// skip into a failure, as in servicecue-bundle-wrangler.test.ts.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, API_TOKEN, FakeCloudflare } from "../main/services/fixtures/fake-cloudflare.js";
import { assetHash, cloudflareOrigin, createCloudflare, failureMarkerOf, readBundle } from "../main/services/servicecue-cloudflare.js";
import { bundleServiceCue, failureMarker } from "./servicecue-bundle.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "publish/servicecue");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "servicecue-bundle-deploy-"));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

describe("the real bundle, deployed to a fake Cloudflare", () => {
  test("registers and uploads every file of the page, and sends deploy.json's metadata", async () => {
    const dir = path.join(OUT, "servicecue");
    const { manifest } = await bundleServiceCue(dir, true);
    const fake = await FakeCloudflare.start();
    try {
      const loaded = readBundle(dir);
      const client = createCloudflare({ origin: cloudflareOrigin(fake.origin), accountId: ACCOUNT_ID, token: API_TOKEN, script: manifest.name });
      const files = await client.deploy(loaded, manifest.version);

      const onDisk: string[] = [];
      const walk = (d: string, rel = ""): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(d, e.name), `${rel}/${e.name}`);
          else onDisk.push(`${rel}/${e.name}`);
        }
      };
      walk(path.join(dir, "public"));
      const registered = (fake.to("POST", `/accounts/${ACCOUNT_ID}/workers/scripts/${manifest.name}/assets-upload-session`)[0].json as { manifest: Record<string, unknown> }).manifest;
      assert.deepEqual(Object.keys(registered).sort(), onDisk.sort(), "every file in public/ is registered, and nothing else");
      assert.equal(Object.keys(registered).includes("/_headers"), false);
      assert.equal(files.uploaded + files.held, onDisk.length);

      const put = fake.puts[0];
      assert.equal(put.metadata.main_module, manifest.mainModule);
      assert.deepEqual(put.metadata.bindings, manifest.bindings);
      assert.deepEqual(put.metadata.exports, manifest.exports);
      assert.deepEqual(put.metadata.keep_bindings, manifest.keep_bindings);
      assert.equal(put.metadata.compatibility_date, manifest.compatibilityDate);
      assert.deepEqual((put.metadata.assets as { config: unknown }).config, manifest.assets);
      assert.deepEqual(put.metadata.annotations, { "workers/message": `Stage Utility ${manifest.version}`, "workers/tag": manifest.build });
      assert.deepEqual(put.parts.map((p) => p.name), [manifest.mainModule]);
      assert.equal(put.parts[0].bytes.toString("utf8"), fs.readFileSync(path.join(dir, manifest.mainModule), "utf8"));
    } finally {
      await fake.close();
    }
  });

  test("the failure marker the bundle leaves is the one the deployer reads", () => {
    for (const dir of [path.join(OUT, "servicecue"), "/somewhere/build/servicecue"]) assert.equal(failureMarkerOf(dir), failureMarker(dir));
  });
});

const BLAKE3 = path.join(WORKER, "node_modules/blake3-wasm");
const present = fs.existsSync(BLAKE3);
const required = process.env.SERVICECUE_REQUIRE_WRANGLER === "1";

describe("wrangler's hash", { skip: present || required ? false : "wrangler is not installed (npm --prefix publish/servicecue ci)" }, () => {
  test("is the one the deployer computes, for files of every kind", () => {
    assert.equal(present, true, "SERVICECUE_REQUIRE_WRANGLER is set and wrangler's dependencies are not installed in publish/servicecue");
    const wasm = createRequire(path.join(WORKER, "package.json"))("blake3-wasm") as { hash(input: string): { toString(encoding: string): string } };
    // wrangler: blake3Wasm.hash(contents.toString("base64") + extension).toString("hex").slice(0, 32)
    const wrangler = (bytes: Buffer, file: string): string => wasm.hash(bytes.toString("base64") + path.extname(file).substring(1)).toString("hex").slice(0, 32);
    const samples: [Buffer, string][] = [
      [Buffer.from("hello"), "/index.html"],
      [Buffer.alloc(0), "/empty.txt"],
      [Buffer.from([0, 255, 128, 10, 13, 0]), "/binary.png"],
      [Buffer.alloc(300_000, 7), "/assets/big.js"],
      [Buffer.from("no extension"), "/NOTICE"],
      [Buffer.from("two dots"), "/assets/a.b.css"],
      [Buffer.from("héllo"), "/unicode.svg"],
    ];
    for (const [bytes, file] of samples) assert.equal(assetHash(bytes, file), wrangler(bytes, file), file);
  });

  test("is still how wrangler hashes: its source has not moved to another algorithm", () => {
    // A tripwire for the day wrangler is upgraded, and not a check on this code: the hash above
    // is only the same while this is. When it fails, read hashFile in wrangler's source and
    // change assetHash to match.
    const cli = fs.readFileSync(path.join(WORKER, "node_modules/wrangler/wrangler-dist/cli.js"), "utf8");
    assert.match(cli, /blake3Wasm\.hash\(base64Contents \+ extension\w*\)\.toString\("hex"\)\.slice\(0, 32\)/);
  });
});
