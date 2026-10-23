// The Cloudflare half of the deployer, against a fake that is a real HTTP server: what goes over
// the socket is what Cloudflare would see. The decisions about WHEN to deploy are in
// servicecue-deployer.test.ts; this file holds the protocol, and that its failures say so.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { ACCOUNT_ID, API_TOKEN, FakeCloudflare, failure } from "./fixtures/fake-cloudflare.js";
import { BUILD_A, BUILD_B, FILES, MANIFEST, writeBundle, type WrittenBundle } from "./fixtures/deploy-bundle.js";
import {
  BundleUnavailable,
  CloudflareError,
  assetHash,
  cloudflareOrigin,
  contentTypeOf,
  createCloudflare,
  readBundle,
  readManifest,
  versionOfMessage,
} from "./servicecue-cloudflare.js";

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
afterEach(() => bundle.remove());

const client = (over: Partial<Parameters<typeof createCloudflare>[0]> = {}) =>
  createCloudflare({ origin: cloudflareOrigin(fake.origin), accountId: ACCOUNT_ID, token: API_TOKEN, script: "servicecue", ...over });

describe("the file hash", () => {
  it("is 32 hex digits of the BLAKE3 hash of the base64 text and the extension, as wrangler computes it", () => {
    // base64("hello") + "html" = "aGVsbG8=html". The vector comes from wrangler 4.150's own
    // blake3-wasm (scripts/servicecue-deploy-wrangler.test.ts runs both and compares).
    assert.equal(assetHash(Buffer.from("hello"), "/index.html"), "a2b82584e50075886b08927390f2f573");
    assert.equal(assetHash(Buffer.from("hello"), "/index.htm"), assetHash(Buffer.from("hello"), "/other/index.htm"));
    assert.notEqual(assetHash(Buffer.from("hello"), "/a.html"), assetHash(Buffer.from("hello"), "/a.css"), "the extension is part of what is hashed");
  });
});

describe("content types", () => {
  it("are wrangler's for what a page build writes, with a charset on text, and none for what it does not know", () => {
    assert.equal(contentTypeOf("/servicecue.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeOf("/assets/x.js"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeOf("/assets/x.css"), "text/css; charset=utf-8");
    assert.equal(contentTypeOf("/favicon.svg"), "image/svg+xml");
    assert.equal(contentTypeOf("/icon.png"), "image/png");
    assert.equal(contentTypeOf("/manifest.webmanifest"), "application/manifest+json");
    assert.equal(contentTypeOf("/assets/font.woff2"), "font/woff2");
    assert.equal(contentTypeOf("/NOTICE"), null);
  });
});

describe("a deploy", () => {
  it("with every file new uploads each once, to the session's token, and attaches them with the completion token", async () => {
    const files = await client().deploy(readBundle(bundle.dir), "1.28.0");
    assert.deepEqual(files, { uploaded: 6, held: 0 });

    const uploads = fake.to("POST", "/accounts/" + ACCOUNT_ID + "/workers/assets/upload");
    assert.equal(uploads.length, 3, "six files, two to a request");
    assert.equal(new Set(uploads.map((u) => u.authorization)).size, 1);
    assert.notEqual(uploads[0].authorization, `Bearer ${API_TOKEN}`, "an upload carries the upload token, not the API token");
    assert.equal(fake.uploaded.size, 6);
    for (const f of readBundle(bundle.dir).files) {
      const got = fake.uploaded.get(f.hash);
      assert.ok(got, f.path);
      assert.equal(got.base64, fs.readFileSync(path.join(bundle.dir, "public", f.path)).toString("base64"), `${f.path} arrives as base64`);
      assert.equal(got.type, f.contentType ?? "application/null", `${f.path} arrives typed as it will be served`);
    }
    assert.equal(fake.puts.length, 1);
  });

  it("with nothing new uploads nothing, and the session's own token is the completion token", async () => {
    for (const f of readBundle(bundle.dir).files) fake.held.add(f.hash);
    const files = await client().deploy(readBundle(bundle.dir), "1.28.0");
    assert.deepEqual(files, { uploaded: 0, held: 6 });
    assert.equal(fake.to("POST", `/accounts/${ACCOUNT_ID}/workers/assets/upload`).length, 0);
    assert.equal(fake.puts.length, 1, "the Worker is still uploaded: that is what changed");
    const session = fake.to("POST", `/accounts/${ACCOUNT_ID}/workers/scripts/servicecue/assets-upload-session`);
    assert.equal(session.length, 1);
  });

  it("with some files new uploads only those, and says how many were already held", async () => {
    const all = readBundle(bundle.dir).files;
    for (const f of all.slice(0, 4)) fake.held.add(f.hash);
    const plans: unknown[] = [];
    const files = await client().deploy(readBundle(bundle.dir), "1.28.0", (p) => plans.push(p));
    assert.deepEqual(files, { uploaded: 2, held: 4 });
    assert.deepEqual(plans, [{ uploaded: 2, held: 4 }], "the plan is known before the first byte goes");
    assert.deepEqual([...fake.uploaded.keys()].sort(), all.slice(4).map((f) => f.hash).sort());
  });

  it("registers every file but `_headers`, by the path the page serves it at, and its hash", async () => {
    // A `_headers` file in public/ is config, never an asset: the same rule as wrangler's.
    fs.writeFileSync(path.join(bundle.dir, "public", "_headers"), "/*\n  X-Stray: 1\n");
    fs.writeFileSync(path.join(bundle.dir, "public", "_redirects"), "/a /b\n");
    await client().deploy(readBundle(bundle.dir), "1.28.0");
    const body = fake.to("POST", `/accounts/${ACCOUNT_ID}/workers/scripts/servicecue/assets-upload-session`)[0].json as { manifest: Record<string, { hash: string; size: number }> };
    // One entry per line, sorted: a path added or dropped shows as one changed line.
    assert.deepEqual(Object.keys(body.manifest).sort(), [
      "/NOTICE",
      "/assets/index-1a2b3c.css",
      "/assets/index-1a2b3c.js",
      "/favicon.svg",
      "/icon-192.png",
      "/servicecue.html",
    ]);
    assert.deepEqual(body.manifest["/servicecue.html"], { hash: assetHash(Buffer.from(FILES["servicecue.html"]), "/servicecue.html"), size: FILES["servicecue.html"].length });
  });

  it("uploads the Worker with exactly the metadata wrangler 4.150 sends", async () => {
    await client().deploy(readBundle(bundle.dir), "1.30.0-beta.2");
    assert.equal(fake.puts.length, 1);
    const put = fake.puts[0];
    const upload = fake.puts[0].metadata.assets as { jwt: string };
    assert.deepEqual(put.metadata, {
      main_module: "worker.js",
      bindings: MANIFEST.bindings,
      compatibility_date: "2026-10-13",
      code_update_strategy: { mode: "deferred", max_delay: 300 },
      exports: { PublishHub: { type: "durable-object", storage: "sqlite" } },
      keep_bindings: ["secret_text", "secret_key"],
      annotations: { "workers/message": "Stage Utility 1.30.0-beta.2", "workers/tag": BUILD_B },
      assets: { jwt: upload.jwt, config: MANIFEST.assets },
    });
    assert.equal((put.metadata.assets as unknown as { config: { _headers: string } }).config._headers, "/*\n  X-Test: 1\n", "`_headers` rides in the assets config");
    assert.deepEqual(
      put.parts.map((p) => ({ name: p.name, type: p.type, text: p.bytes.toString("utf8") })),
      [{ name: "worker.js", type: "application/javascript+module", text: fs.readFileSync(path.join(bundle.dir, "worker.js"), "utf8") }],
    );
    assert.equal(put.query, "excludeScript=true&bindings_inherit=strict");
    assert.equal(fake.requests.at(-1)?.authorization, `Bearer ${API_TOKEN}`, "the Worker goes up with the API token");
  });

  it("sends compatibility flags when there are some, and no Durable Object strategy for a Worker with none", async () => {
    bundle.remove();
    bundle = writeBundle({ manifest: { compatibilityFlags: ["nodejs_compat"], exports: {} } });
    await client().deploy(readBundle(bundle.dir), "1.28.0");
    const { metadata } = fake.puts[0];
    assert.deepEqual(metadata.compatibility_flags, ["nodejs_compat"]);
    assert.equal("exports" in metadata, false);
    assert.equal("code_update_strategy" in metadata, false);
  });

  it("uploads one file to a request when the session's token says that is how this account takes them", async () => {
    fake.singleUploads = true;
    const files = await client().deploy(readBundle(bundle.dir), "1.28.0");
    assert.deepEqual(files, { uploaded: 6, held: 0 });
    const uploads = fake.requests.filter((r) => /\/workers\/assets\/upload\/[0-9a-f]{32}$/.test(r.path));
    assert.equal(uploads.length, 6);
    assert.equal(fake.puts.length, 1);
  });

  it("fails on an upload that is refused, and the Worker is never uploaded", async () => {
    fake.respond = (r) => (r.path.startsWith(`/accounts/${ACCOUNT_ID}/workers/assets/upload`) ? failure(500, 10013, "internal error, try again") : undefined);
    await assert.rejects(
      client().deploy(readBundle(bundle.dir), "1.28.0"),
      (err: unknown) => err instanceof CloudflareError && err.step === "upload the files" && err.status === 500 && err.code === 10013 && /internal error/.test(err.message) && !err.refused,
    );
    assert.equal(fake.puts.length, 0, "nothing was attached to the Worker");
  });

  it("fails when the last upload brings no completion token", async () => {
    fake.respond = (r) => (r.path.startsWith(`/accounts/${ACCOUNT_ID}/workers/assets/upload`) ? { status: 200, body: { success: true, errors: [], result: {} } } : undefined);
    await assert.rejects(client().deploy(readBundle(bundle.dir), "1.28.0"), /no completion token/);
    assert.equal(fake.puts.length, 0);
  });

  it("fails when Cloudflare asks for a file the bundle does not have", async () => {
    fake.respond = (r) =>
      r.path.endsWith("/assets-upload-session") ? { status: 200, body: { success: true, errors: [], result: { jwt: "x.y.z", buckets: [["f".repeat(32)]] } } } : undefined;
    await assert.rejects(client().deploy(readBundle(bundle.dir), "1.28.0"), /not in the bundle/);
    assert.equal(fake.puts.length, 0);
  });

  it("is refused with the code and words Cloudflare gave, and 401 and 403 are `refused`", async () => {
    fake.respond = (r) => (r.method === "PUT" ? failure(403, 10000, "Authentication error") : undefined);
    await assert.rejects(
      client().deploy(readBundle(bundle.dir), "1.28.0"),
      (err: unknown) => err instanceof CloudflareError && err.refused && err.code === 10000 && err.step === "upload the Worker" && err.message === "Authentication error",
    );
  });

  it("never puts the API token, or a token Cloudflare handed back, in what a failure says", async () => {
    fake.respond = (r) => {
      if (r.method !== "PUT") return undefined;
      const jwt = ((r.bytes.toString("utf8").match(/"jwt":"([^"]+)"/) ?? [])[1] ?? "").trim();
      // A careless API echoing what it was sent.
      return failure(400, 10021, `bad request, saw ${API_TOKEN} and ${jwt}`);
    };
    await assert.rejects(client().deploy(readBundle(bundle.dir), "1.28.0"), (err: unknown) => {
      const text = (err as Error).message;
      assert.doesNotMatch(text, new RegExp(API_TOKEN));
      assert.doesNotMatch(text, /\.sig/, "a completion token is JWT-shaped");
      assert.match(text, /\[removed\]/);
      return true;
    });
  });

  it("does not follow a redirect, which would carry the token where it pointed", async () => {
    fake.respond = () => ({ status: 302, body: {}, headers: { Location: `${fake.origin}/elsewhere` } });
    await assert.rejects(client().verifyToken(), CloudflareError);
    assert.equal(fake.requests.length, 1, "the redirect was not taken");
  });

  it("reports an answer that is not Cloudflare's, with the status", async () => {
    fake.respond = () => ({ status: 403, body: "<html>blocked</html>" });
    await assert.rejects(client().verifyToken(), (err: unknown) => err instanceof CloudflareError && err.status === 403 && /not Cloudflare's API/.test(err.message));
  });
});

describe("a Worker that is not on the account", () => {
  it("is said plainly before anything is uploaded or created, and a read says it too", async () => {
    fake.missingWorker = true;
    await assert.rejects(
      client().deploy(readBundle(bundle.dir), "1.28.0"),
      (err: unknown) => err instanceof CloudflareError && err.step === "check the Worker exists" && /the Worker 'servicecue' does not exist on this account: create it once by hand/.test(err.message),
    );
    assert.equal(fake.requests.filter((r) => r.method !== "GET").length, 0, "something was sent that would have created the Worker");
    await assert.rejects(client().deployedPage(), /the Worker 'servicecue' does not exist/);
  });

  it("names a Worker outside the token's scope, as real Cloudflare answers it (403 after an accepted token)", async () => {
    fake.noRoleOnWorker = true;
    const scoped = (err: unknown) =>
      err instanceof CloudflareError && err.status === 403 && err.refused && /this token has no access to the Worker 'servicecue': it may not exist, or the token is not given Editor on it/.test(err.message);
    await assert.rejects(client().deployedPage(), scoped);
    await assert.rejects(client().deploy(readBundle(bundle.dir), "1.28.0"), scoped);
    assert.equal(fake.puts.length, 0);
  });

  it("does not hide another failure of the check as a missing Worker", async () => {
    fake.respond = (r) => (r.path.endsWith("/settings") ? failure(500, 1, "down") : undefined);
    await assert.rejects(client().deploy(readBundle(bundle.dir), "1.28.0"), (err: unknown) => err instanceof CloudflareError && err.status === 500 && !/does not exist/.test(err.message));
    assert.equal(fake.puts.length, 0);
  });
});

describe("a failure, described", () => {
  it("names the request, what answered, Cloudflare's code and its words, in one line", () => {
    assert.equal(new CloudflareError("down", 500, 10013, "upload the files").describe(), 'at "upload the files" (HTTP 500, code 10013): down');
    assert.equal(new CloudflareError("no route to host", null, null, "verify the token").describe(), 'at "verify the token" (no answer): no route to host');
  });
});

describe("verifying the token", () => {
  it("is one request to the user's address, for a token made under a person", async () => {
    await client().verifyToken();
    assert.deepEqual(fake.requests.map((r) => r.path), ["/user/tokens/verify"]);
  });

  it("falls back to the account's address, for a token made under the account", async () => {
    fake.accountToken = true;
    await client().verifyToken();
    assert.deepEqual(fake.requests.map((r) => r.path), ["/user/tokens/verify", `/accounts/${ACCOUNT_ID}/tokens/verify`]);
  });

  it("is refused when neither accepts it, with the first answer's code and words", async () => {
    await assert.rejects(
      client({ token: "some-other-token-0123456789abcdef" }).verifyToken(),
      (err: unknown) => err instanceof CloudflareError && err.refused && err.code === 1000 && err.message === "Invalid API Token",
    );
  });

  it("does not try the account's address after an answer that is not a refusal", async () => {
    fake.respond = () => failure(503, 1, "unavailable");
    await assert.rejects(client().verifyToken(), (err: unknown) => err instanceof CloudflareError && !err.refused);
    assert.equal(fake.requests.length, 1);
  });

  it("refuses a token Cloudflare says is not active", async () => {
    fake.respond = () => ({ status: 200, body: { success: true, errors: [], result: { status: "expired" } } });
    await assert.rejects(client().verifyToken(), (err: unknown) => err instanceof CloudflareError && err.refused && /expired/.test(err.message));
  });
});

describe("reading what is deployed", () => {
  it("reads the build and the version this server recorded, from the version with the traffic", async () => {
    await client().deploy(readBundle(bundle.dir), "1.28.0");
    const page = await client().deployedPage();
    assert.equal(page.build, BUILD_B);
    assert.equal(page.version, "1.28.0");
    assert.ok(page.at !== null && Math.abs(page.at - Date.now()) < 60_000);
  });

  it("knows nothing of a version deployed by hand: no annotation, no version", async () => {
    fake.deployed = { at: new Date().toISOString() };
    assert.deepEqual({ ...(await client().deployedPage()), at: null }, { build: null, version: null, at: null });
  });

  it("knows nothing of a Worker with no deployment", async () => {
    assert.deepEqual(await client().deployedPage(), { build: null, version: null, at: null });
  });

  it("does not take a message this server did not write for a version", async () => {
    fake.deployed = { tag: BUILD_A, message: "hotfix by hand", at: new Date().toISOString() };
    assert.equal((await client().deployedPage()).version, null);
    assert.equal((await client().deployedPage()).build, BUILD_A);
    assert.equal(versionOfMessage("Stage Utility 1.2.3-beta.4"), "1.2.3-beta.4");
    assert.equal(versionOfMessage("Stage Utility 1.2"), null);
    assert.equal(versionOfMessage("Stage Utility 1.2.3 and more"), null);
  });

  it("says why when Cloudflare will not tell", async () => {
    fake.respond = () => failure(500, 10007, "down");
    await assert.rejects(client().deployedPage(), (err: unknown) => err instanceof CloudflareError && err.code === 10007 && err.step === "read the deployed version");
  });
});

describe("the address", () => {
  it("is Cloudflare's, or this machine's over plain http, and nothing else", () => {
    assert.equal(cloudflareOrigin(), "https://api.cloudflare.com");
    assert.equal(cloudflareOrigin("http://127.0.0.1:9999"), "http://127.0.0.1:9999");
    for (const bad of ["https://evil.example", "http://api.cloudflare.com", "http://192.0.2.1:80", "not a url", "https://api.cloudflare.com.evil.example"]) {
      assert.throws(() => cloudflareOrigin(bad), /Cloudflare API address/, bad);
    }
  });

  it("is refused for an account id or a Worker name that would change the path", () => {
    assert.throws(() => client({ accountId: "../x" }), /account ID/);
    assert.throws(() => client({ script: "a/b" }), /Worker's name/);
  });
});

describe("the folder", () => {
  it("reads the manifest and every file, in order", () => {
    const b = readBundle(bundle.dir);
    assert.equal(b.manifest.build, BUILD_B);
    assert.deepEqual(b.files.map((f) => f.path), Object.keys(FILES).map((f) => `/${f}`).sort());
  });

  it("says there is no copy of the page when there is no folder, and why when the build failed", () => {
    const missing = path.join(bundle.dir, "..", "nothing-here");
    assert.throws(() => readManifest(missing), (e: unknown) => e instanceof BundleUnavailable && /has no copy of the page: it has no build\/servicecue\/deploy.json/.test(e.message));
    fs.writeFileSync(`${missing}.failed`, "abc123\nvite could not load\n");
    assert.throws(() => readManifest(missing), (e: unknown) => e instanceof BundleUnavailable && /its bundle failed \(vite could not load\)/.test(e.message));
  });

  it("refuses a deploy.json it cannot read field by field, naming the field", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["no usable Worker name", { name: "a/b" }],
      ["no build id", { build: "xyz" }],
      ["no version", { version: "latest" }],
      ["no compatibility date", { compatibilityDate: "yesterday" }],
      ["no assets config with the headers text", { assets: { html_handling: "none" } }],
      ["a binding it cannot read", { bindings: [{ type: "kv", name: "X" }] }],
      ["does not keep secret_text bindings, which would delete the publishing token", { keep_bindings: "secret_text" }],
      ["does not keep secret_text bindings, which would delete the publishing token", { keep_bindings: ["secret_key"] }],
      ["does not keep secret_text bindings, which would delete the publishing token", { keep_bindings: [] }],
      ["no exports", { exports: null }],
    ];
    for (const [what, over] of cases) {
      fs.writeFileSync(path.join(bundle.dir, "deploy.json"), JSON.stringify({ ...MANIFEST, ...over }));
      assert.throws(() => readManifest(bundle.dir), (e: unknown) => e instanceof BundleUnavailable && e.message.includes(what), what);
    }
    fs.writeFileSync(path.join(bundle.dir, "deploy.json"), "{ not json");
    assert.throws(() => readManifest(bundle.dir), /is not JSON/);
  });

  it("refuses a page with no files", () => {
    fs.rmSync(path.join(bundle.dir, "public"), { recursive: true });
    fs.mkdirSync(path.join(bundle.dir, "public"));
    assert.throws(() => readBundle(bundle.dir), /no files/);
  });
});
