// The Mac output helper's download: fetched from the release once, checked
// against the digest GitHub's releases API lists for the zip, cached, and served
// from the cache.
//
// A fake fetch stands in for GitHub, so every case here runs the real module end
// to end — real files in a real temporary data directory, real hashing, real
// single-flight — with only the network replaced.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { WatchdogTimers } from "./capped-download.js";
import { captureConsole } from "./fixtures/capture-console.js";
import { assetDigest, OutputHelperDownloads, parseChecksum, parseHelperPath, pruneOutputHelperCache, releaseHosts, type HelperAsset } from "./output-helper-download.js";

const VERSION = "1.2.3-beta.4";
const ZIP = parseHelperPath("/kiosk/StageUtilityOutput-arm64.zip") as HelperAsset;
const SUM = parseHelperPath("/kiosk/StageUtilityOutput-arm64.zip.sha256") as HelperAsset;
const ZIP_SIG = parseHelperPath("/kiosk/StageUtilityOutput-arm64.zip.sig") as HelperAsset;
const LAUNCHER_SIG = parseHelperPath("/kiosk/kiosk-windows.ps1.sig") as HelperAsset;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

const API_PATH = `/api/releases/tags/v${VERSION}`;

/** A stand-in for the release host and the releases API: what they serve, and what was asked of them. */
class FakeRelease {
  files = new Map<string, { status?: number; body: Buffer; headers?: Record<string, string> }>();
  /** The assets the release's JSON lists. A release publishes no .sha256 file; the digest is a field here. */
  assets: { name: string; digest?: unknown }[] = [];
  /** The API's whole answer, when a test wants something other than the assets above. */
  record: { status?: number; body: Buffer | string; headers?: Record<string, string> } | null = null;
  requests: string[] = [];
  /** The headers of each API call, newest last. */
  apiHeaders: Headers[] = [];
  offline = false;
  /** Held until released, so a test can start requests while a fetch is in flight. */
  gate: Promise<void> | null = null;
  /** When set, only requests for this version wait at the gate. */
  gateOnly: string | null = null;
  /** The assets another version's JSON lists, by version. */
  otherAssets = new Map<string, { name: string; digest?: unknown }[]>();

  publish(name: string, body: Buffer, digest = sha(body)): void {
    this.files.set(`/v${VERSION}/${name}`, { body });
    this.assets = [...this.assets.filter((a) => a.name !== name), { name, digest: `sha256:${digest}` }];
  }

  /** The same, for a version other than the running one. */
  publishVersion(version: string, name: string, body: Buffer): void {
    this.files.set(`/v${version}/${name}`, { body });
    this.otherAssets.set(version, [{ name, digest: `sha256:${sha(body)}` }]);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.requests.push(url.pathname);
    if (this.offline) throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND github.com") });
    if (this.gate && (this.gateOnly === null || url.pathname.includes(`v${this.gateOnly}`))) await this.gate;
    init?.signal?.throwIfAborted();
    const other = /^\/api\/releases\/tags\/v(.+)$/.exec(url.pathname)?.[1];
    if (other !== undefined && other !== VERSION) {
      return new Response(JSON.stringify({ assets: this.otherAssets.get(other) ?? [] }), { status: 200 });
    }
    if (url.pathname === API_PATH) {
      this.apiHeaders.push(new Headers(init?.headers));
      const r = this.record ?? { body: JSON.stringify({ tag_name: `v${VERSION}`, assets: this.assets }, null, 2) };
      return new Response(typeof r.body === "string" ? r.body : new Uint8Array(r.body), { status: r.status ?? 200, headers: r.headers });
    }
    const file = this.files.get(url.pathname);
    if (!file) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(file.body), { status: file.status ?? 200, headers: file.headers });
  };

  count(suffix: string): number {
    return this.requests.filter((r) => r.endsWith(suffix)).length;
  }

  /** How many times the releases API was asked for the release's record. */
  apiCalls(): number {
    return this.requests.filter((r) => r === API_PATH).length;
  }
}

let dataDir: string;
let release: FakeRelease;

const make = (extra: Partial<ConstructorParameters<typeof OutputHelperDownloads>[0]> = {}) =>
  new OutputHelperDownloads({ dataDir: () => dataDir, version: () => VERSION, fetch: release.fetch, releaseHosts: () => ({ download: "https://release.test", api: "https://release.test/api/releases/tags" }), ...extra });

const cacheDir = () => path.join(dataDir, "cache", "output-helper", VERSION);
const listCache = async () => (await fs.readdir(cacheDir()).catch(() => [])).sort();

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "su-helper-dl-"));
  release = new FakeRelease();
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("the helper download path", () => {
  it("names exactly the two architectures and the checksum beside each", () => {
    assert.deepEqual(parseHelperPath("/kiosk/StageUtilityOutput-arm64.zip"), { arch: "arm64", kind: "zip", name: "StageUtilityOutput-arm64.zip" });
    assert.deepEqual(parseHelperPath("/kiosk/StageUtilityOutput-x86_64.zip.sha256"), { arch: "x86_64", kind: "sha256", name: "StageUtilityOutput-x86_64.zip.sha256" });
  });

  it("names a signature beside each zip, and one for the Windows launcher, and no other", () => {
    assert.deepEqual(parseHelperPath("/kiosk/StageUtilityOutput-arm64.zip.sig"), { kind: "sig", name: "StageUtilityOutput-arm64.zip.sig" });
    assert.deepEqual(parseHelperPath("/kiosk/StageUtilityOutput-x86_64.zip.sig"), { kind: "sig", name: "StageUtilityOutput-x86_64.zip.sig" });
    assert.deepEqual(parseHelperPath("/kiosk/kiosk-windows.ps1.sig"), { kind: "sig", name: "kiosk-windows.ps1.sig" });
    for (const p of ["/kiosk/StageUtilityOutput-arm64.zip.sha256.sig", "/kiosk/kiosk-update-windows.ps1.sig", "/kiosk/install-macos.sh.sig", "/kiosk/kiosk-windows.ps1.sig.sig"]) {
      assert.equal(parseHelperPath(p), null, p);
    }
  });

  it("refuses everything else, traversal included", () => {
    for (const p of [
      "/kiosk/StageUtilityOutput-ppc.zip",
      "/kiosk/StageUtilityOutput-arm64.zip.sha256.sha256",
      "/kiosk/StageUtilityOutput-arm64.tar",
      "/kiosk/../StageUtilityOutput-arm64.zip",
      "/kiosk/StageUtilityOutput-../../etc/passwd.zip",
      "/kiosk/StageUtilityOutput-arm64.zip/",
      "/kiosk/StageUtilityOutput-arm64.zip%2e",
      "/StageUtilityOutput-arm64.zip",
    ]) {
      assert.equal(parseHelperPath(p), null, p);
    }
  });

  it("reads the digest from shasum output and from a bare digest, and from nothing else", () => {
    const d = "a".repeat(64);
    assert.equal(parseChecksum(`${d}  StageUtilityOutput-arm64.zip\n`), d);
    assert.equal(parseChecksum(d.toUpperCase()), d);
    assert.equal(parseChecksum("not a digest"), null);
    assert.equal(parseChecksum(`${"a".repeat(63)}\n`), null);
    assert.equal(parseChecksum(`${"a".repeat(65)}\n`), null);
  });
});

describe("fetching the helper from the release", () => {
  it("fetches once on a miss, then serves from the cache without touching the network", async (t) => {
    const lines = captureConsole(t, "log");
    const bytes = crypto.randomBytes(300_000);
    release.publish(ZIP.name, bytes);
    const dl = make();

    const first = await dl.resolve(ZIP);
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.source, "release");
    assert.deepEqual(await fs.readFile(first.file), bytes);
    assert.equal(release.count(".zip"), 1);
    assert.equal(release.apiCalls(), 1);
    assert.ok(!release.requests.some((r) => r.endsWith(".sha256")), "the release has no .sha256 file to ask for");

    const asked = release.requests.length;
    const second = await dl.resolve(ZIP);
    assert.ok(second.ok);
    assert.equal(second.source, "cache");
    assert.equal(release.requests.length, asked, "a cache hit must not go to the network");

    // The checksum comes out of the same cache, in shasum form, for the installer.
    const sum = await dl.resolve(SUM);
    assert.ok(sum.ok && sum.source === "cache");
    assert.equal(await fs.readFile(sum.file, "utf8"), `${sha(bytes)}  ${ZIP.name}\n`);
    assert.equal(release.requests.length, asked);
    assert.ok(lines.some((l) => l === `[output-helper] read the SHA-256 of ${ZIP.name} from the release record for v${VERSION}`), lines.join("\n"));

    assert.ok(lines.some((l) => l.startsWith("[output-helper] fetched StageUtilityOutput-arm64.zip") && l.includes("verified its SHA-256")), lines.join("\n"));
    assert.ok(lines.some((l) => l.startsWith("[output-helper] serving StageUtilityOutput-arm64.zip from the cache")), lines.join("\n"));
  });

  it("refuses a download whose digest is not the published one, and caches nothing", async (t) => {
    const lines = captureConsole(t, "warn");
    release.publish(ZIP.name, crypto.randomBytes(50_000), sha("some other file"));
    const dl = make();

    const r = await dl.resolve(ZIP);
    assert.ok(!r.ok);
    assert.equal(r.status, 502);
    assert.match(r.message, /did not match the release's SHA-256/);
    assert.deepEqual(await listCache(), [], "neither the zip, its checksum nor a partial file may be left");
    assert.ok(lines.some((l) => l.startsWith("[output-helper] StageUtilityOutput-arm64.zip failed:")), lines.join("\n"));

    // And it is not remembered as bad or good: the next request tries again, and
    // asks the API for the digest again, since the one it read is not kept.
    const before = release.count(".zip");
    const asked = release.apiCalls();
    await dl.resolve(ZIP);
    assert.equal(release.count(".zip"), before + 1);
    assert.equal(release.apiCalls(), asked + 1, "a digest that did not match the zip is not cached");
  });

  it("answers 404 with a plain reason when there is no internet and no cache", async (t) => {
    captureConsole(t, "warn");
    release.offline = true;
    const r = await make().resolve(ZIP);
    assert.ok(!r.ok);
    assert.equal(r.status, 404);
    assert.match(r.message, /not in the cache and could not be fetched/);
    assert.match(r.message, /ENOTFOUND github\.com/);
    assert.deepEqual(await listCache(), []);
  });

  it("serves a cached file with no internet", async () => {
    release.publish(ZIP.name, Buffer.from("zip bytes"));
    const dl = make();
    assert.ok((await dl.resolve(ZIP)).ok);
    release.offline = true;
    const again = await dl.resolve(ZIP);
    assert.ok(again.ok && again.source === "cache");
  });

  describe("a release that cannot give a digest for the zip", () => {
    /** The refusal for `resolve(ZIP)`, with the warning line it logged. */
    const refused = async (t: Parameters<typeof captureConsole>[0], dl = make()) => {
      const lines = captureConsole(t, "warn");
      const r = await dl.resolve(ZIP);
      assert.ok(!r.ok, "expected a refusal");
      assert.equal(release.count(".zip"), 0, "an unverifiable download must not even start");
      assert.deepEqual(await listCache(), [], "nothing is stored");
      assert.ok(lines.some((l) => l.startsWith("[output-helper] StageUtilityOutput-arm64.zip failed: ") && l.includes(r.message)), lines.join("\n"));
      return r;
    };

    it("answers 404 when there is no such release", async (t) => {
      release.record = { status: 404, body: JSON.stringify({ message: "Not Found" }) };
      const r = await refused(t);
      assert.equal(r.status, 404);
      assert.equal(r.message, `there is no release v${VERSION} on GitHub`);
    });

    it("answers 502 and says why when the release lists the zip with no digest", async (t) => {
      release.assets = [{ name: ZIP.name }];
      const r = await refused(t);
      assert.equal(r.status, 502);
      assert.match(r.message, new RegExp(`lists ${ZIP.name} with no digest \\(GitHub only began serving asset digests in 2025`));
    });

    it("answers 502 for any other status, and says how long a rate limit lasts", async (t) => {
      const resetsIn10 = String(Math.floor(Date.now() / 1000) + 600);
      release.record = { status: 403, body: "{}", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetsIn10 } };
      const limited = await refused(t);
      assert.equal(limited.status, 502);
      assert.match(limited.message, /answered 403 for the release record of v.* \(GitHub's hourly limit for this network is used up — it resets in (9|10) min\.\)/);
      release.record = { status: 500, body: "oops" };
      const broken = await make().resolve(ZIP);
      assert.ok(!broken.ok);
      assert.equal(broken.status, 502);
      assert.match(broken.message, /answered 500 for the release record of v[^(]*$/);
    });

    // An explicit timeout: with no signal on the request, the fake would never be
    // told to stop and this would await it for ever instead of failing.
    it("gives up on a releases API that never answers, as the same 404 as no internet", { timeout: 3000 }, async (t) => {
      const real = release.fetch;
      release.fetch = (input, init) =>
        new URL(String(input)).pathname === API_PATH
          ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
          : real(input, init);
      const r = await refused(t, make({ digestTimeoutMs: 50 }));
      assert.equal(r.status, 404);
      assert.match(r.message, /not in the cache and could not be fetched/);
    });
  });

  describe("a payload's signature", () => {
    const signature = crypto.randomBytes(384);

    for (const asset of [ZIP_SIG, LAUNCHER_SIG]) {
      it(`fetches ${asset.name} once, checked against the release's digest for it, then serves it from the cache`, async (t) => {
        const lines = captureConsole(t, "log");
        release.publish(asset.name, signature);
        const dl = make();
        const first = await dl.resolve(asset);
        assert.ok(first.ok && first.source === "release", JSON.stringify(first));
        assert.deepEqual(await fs.readFile(first.file), signature);
        assert.equal(first.size, 384);
        assert.equal(release.count(`/${asset.name}`), 1);
        assert.equal(release.apiCalls(), 1, "its digest comes from the release record");
        assert.ok(lines.includes(`[output-helper] fetched ${asset.name} from the release for v${VERSION} and verified its SHA-256`), lines.join("\n"));

        const asked = release.requests.length;
        release.offline = true;
        const restarted = make(); // a new process, with no internet
        const again = await restarted.resolve(asset);
        assert.ok(again.ok && again.source === "cache", JSON.stringify(again));
        assert.equal(release.requests.length, asked, "a cached signature does not go back to the network");
      });
    }

    it("answers 404 when the release lists no signature, fetches nothing else, and stores nothing", async (t) => {
      const lines = captureConsole(t, "warn");
      release.publish(ZIP.name, Buffer.from("zip")); // a release from before signing
      const r = await make().resolve(ZIP_SIG);
      assert.ok(!r.ok);
      assert.equal(r.status, 404);
      assert.equal(r.message, `the release for v${VERSION} has no ${ZIP_SIG.name}`);
      assert.equal(release.count(".sig"), 0, "no digest, no download");
      assert.deepEqual(await listCache(), []);
      assert.ok(lines.some((l) => l.startsWith(`[output-helper] ${ZIP_SIG.name} failed: the release for v${VERSION} has no`)), lines.join("\n"));
    });

    it("refuses a signature that does not match the release's digest for it, and stores nothing", async (t) => {
      captureConsole(t, "warn");
      release.publish(LAUNCHER_SIG.name, signature, sha("another file"));
      const r = await make().resolve(LAUNCHER_SIG);
      assert.ok(!r.ok);
      assert.equal(r.status, 502);
      assert.match(r.message, /^kiosk-windows\.ps1\.sig did not match the release's SHA-256 \(expected [0-9a-f]{64}, got [0-9a-f]{64}\); not stored$/);
      assert.deepEqual(await listCache(), []);
    });

    it("refuses a signature over 16 KiB without storing it", async (t) => {
      captureConsole(t, "warn");
      release.publish(ZIP_SIG.name, Buffer.alloc(16 * 1024 + 1, 1));
      const r = await make().resolve(ZIP_SIG);
      assert.ok(!r.ok);
      assert.equal(r.status, 502);
      assert.match(r.message, /is larger than 16384 bytes; refusing it/);
      assert.deepEqual(await listCache(), []);
    });

    it("gives up on a signature download that never answers, and stores nothing", { timeout: 3000 }, async (t) => {
      captureConsole(t, "warn");
      release.publish(ZIP_SIG.name, signature);
      const real = release.fetch;
      release.fetch = (input, init) =>
        new URL(String(input)).pathname.endsWith(".sig")
          ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
          : real(input, init);
      const r = await make({ digestTimeoutMs: 50 }).resolve(ZIP_SIG);
      assert.ok(!r.ok);
      assert.equal(r.status, 404);
      assert.match(r.message, /not in the cache and could not be fetched/);
      assert.deepEqual(await listCache(), []);
    });

    it("shares one fetch between concurrent requests", async (t) => {
      captureConsole(t, "log");
      release.publish(ZIP_SIG.name, signature);
      let open!: () => void;
      release.gate = new Promise<void>((r) => (open = r));
      const dl = make();
      const both = Promise.all([dl.resolve(ZIP_SIG), dl.resolve(ZIP_SIG)]);
      open();
      const [a, b] = await both;
      assert.ok(a.ok && b.ok);
      assert.equal(release.count(".sig"), 1);
    });
  });

  it("asks the releases API the way the updater does: the GitHub media type and a User-Agent", async (t) => {
    captureConsole(t, "log", "warn");
    release.publish(ZIP.name, Buffer.from("zip"));
    assert.ok((await make().resolve(SUM)).ok);
    assert.equal(release.apiHeaders.length, 1);
    assert.equal(release.apiHeaders[0].get("accept"), "application/vnd.github+json");
    assert.equal(release.apiHeaders[0].get("user-agent"), "stage-utility-output-helper");
  });

  it("serves the digest as one shasum line it builds itself, lowercased, whatever case the API used", async (t) => {
    captureConsole(t, "log", "warn");
    const digest = sha("zip bytes");
    release.assets = [{ name: ZIP.name, digest: `sha256:${digest.toUpperCase()}` }];
    const r = await make().resolve(SUM);
    assert.ok(r.ok, JSON.stringify(r));
    const text = await fs.readFile(r.file, "utf8");
    assert.equal(text, `${digest}  ${ZIP.name}\n`);
    assert.match(text, /^[0-9a-f]{64} {2}StageUtilityOutput-arm64\.zip\n$/);
    assert.equal(r.size, Buffer.byteLength(text));
  });

  it("keeps the digest per version, so a restart serves the cached zip without asking the API again", async (t) => {
    captureConsole(t, "log", "warn");
    release.publish(ZIP.name, crypto.randomBytes(20_000));
    assert.ok((await make().resolve(ZIP)).ok);
    const asked = release.requests.length;
    release.offline = true;
    const restarted = make(); // a new process
    const r = await restarted.resolve(ZIP);
    assert.ok(r.ok && r.source === "cache", JSON.stringify(r));
    assert.equal((await restarted.resolve(SUM)).ok, true);
    assert.equal(release.requests.length, asked, "neither the zip nor the digest went back to the network");
  });

  describe("the digest assetDigest reads from a release record", () => {
    const good = "b".repeat(64);
    const record = (assets: unknown) => JSON.stringify({ assets });
    const refusal = (status: number, message: RegExp) => (e: unknown) =>
      e instanceof Error && (e as Error & { status?: number }).status === status && message.test(e.message);
    const notSha = /is not a SHA-256/;

    it("is the digest of the asset whose name is exactly the zip's, wherever it is listed, in lowercase", () => {
      const body = record([
        { name: `${ZIP.name}.sha256`, digest: `sha256:${"c".repeat(64)}` },
        { name: "StageUtilityOutput-x86_64.zip", digest: `sha256:${"d".repeat(64)}` },
        { name: ZIP.name, digest: `sha256:${good.toUpperCase()}` },
      ]);
      assert.equal(assetDigest(body, VERSION, ZIP.name), good);
    });

    const cases: [string, unknown, number, RegExp][] = [
      ["no asset of that name", [{ name: "stage-utility-1.2.3-linux-x64.tar.gz", digest: `sha256:${good}` }], 404, /has no StageUtilityOutput-arm64\.zip$/],
      ["only another architecture's", [{ name: "StageUtilityOutput-x86_64.zip", digest: `sha256:${good}` }], 404, /has no /],
      ["only a prefixed name", [{ name: `${ZIP.name}.sha256`, digest: `sha256:${good}` }], 404, /has no /],
      ["an asset named __proto__", [{ name: "__proto__", digest: `sha256:${good}` }], 404, /has no /],
      ["no list entries that are objects", [null, 7, "x"], 404, /has no /],
      ["no digest key", [{ name: ZIP.name }], 502, /with no digest \(GitHub only began serving asset digests in 2025/],
      ["a null digest", [{ name: ZIP.name, digest: null }], 502, /with no digest/],
      ["an empty digest", [{ name: ZIP.name, digest: "" }], 502, /with no digest/],
      ["another algorithm", [{ name: ZIP.name, digest: `sha512:${"a".repeat(64)}` }], 502, notSha],
      ["63 digits", [{ name: ZIP.name, digest: `sha256:${"a".repeat(63)}` }], 502, notSha],
      ["65 digits", [{ name: ZIP.name, digest: `sha256:${"a".repeat(65)}` }], 502, notSha],
      ["not hex", [{ name: ZIP.name, digest: `sha256:${"g".repeat(64)}` }], 502, notSha],
      ["bare hex, no prefix", [{ name: ZIP.name, digest: "a".repeat(64) }], 502, notSha],
      ["trailing text", [{ name: ZIP.name, digest: `sha256:${"a".repeat(64)} extra` }], 502, notSha],
      ["a digest that is not a string", [{ name: ZIP.name, digest: 12345 }], 502, notSha],
    ];
    for (const [label, assets, status, message] of cases) {
      it(`refuses ${label}: ${status}`, () => {
        assert.throws(() => assetDigest(record(assets), VERSION, ZIP.name), refusal(status, message));
      });
    }

    for (const [label, body, message] of [
      ["a body that is not JSON", "<html>Bad gateway</html>", /is not JSON/],
      ["JSON null", "null", /lists no assets array/],
      ["assets that are not a list", JSON.stringify({ assets: "none" }), /lists no assets array/],
    ] as const) {
      it(`refuses ${label}: 502`, () => {
        assert.throws(() => assetDigest(body, VERSION, ZIP.name), refusal(502, message));
      });
    }
  });

  it("points the API, with the downloads, at one test base, and at GitHub when it is unset", (t) => {
    captureConsole(t, "warn");
    const was = process.env.STAGE_UTILITY_TEST_RELEASE_BASE;
    try {
      delete process.env.STAGE_UTILITY_TEST_RELEASE_BASE;
      assert.deepEqual(releaseHosts(), {
        download: "https://github.com/Cornerstone-Production/Stage-Utility/releases/download",
        api: "https://api.github.com/repos/Cornerstone-Production/Stage-Utility/releases/tags",
      });
      process.env.STAGE_UTILITY_TEST_RELEASE_BASE = "http://127.0.0.1:9/";
      assert.deepEqual(releaseHosts(), { download: "http://127.0.0.1:9", api: "http://127.0.0.1:9/api/releases/tags" });
    } finally {
      if (was === undefined) delete process.env.STAGE_UTILITY_TEST_RELEASE_BASE;
      else process.env.STAGE_UTILITY_TEST_RELEASE_BASE = was;
    }
  });

  it("shares one fetch between concurrent requests for the same file", async () => {
    const bytes = crypto.randomBytes(100_000);
    release.publish(ZIP.name, bytes);
    let open!: () => void;
    release.gate = new Promise((r) => (open = r));
    const dl = make();

    const all = [dl.resolve(ZIP), dl.resolve(ZIP), dl.resolve(SUM), dl.resolve(ZIP), dl.resolve(SUM)];
    await new Promise((r) => setTimeout(r, 20));
    open();
    const results = await Promise.all(all);

    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    assert.equal(release.count(".zip"), 1, "one download of the zip for five requests");
    assert.equal(release.apiCalls(), 1, "one read of the release record, shared with the zip's own");
    assert.deepEqual(await listCache(), [ZIP.name, SUM.name]);
  });

  it("does not let a request for a newer version join the flight fetching the older one", { timeout: 5000 }, async (t) => {
    captureConsole(t, "log", "warn");
    const OLD = "1.0.0";
    release.publishVersion(OLD, ZIP.name, Buffer.from("old zip"));
    release.publish(ZIP.name, Buffer.from("new zip"));
    let open!: () => void;
    release.gate = new Promise((r) => (open = r));
    release.gateOnly = OLD; // only the old version's fetches are held
    let running = OLD;
    const dl = make({ version: () => running });

    const oldFlight = dl.resolve(ZIP);
    await new Promise((r) => setTimeout(r, 20));
    running = VERSION; // the server updated while the old fetch was in flight
    const newer = await Promise.race([dl.resolve(ZIP), new Promise<"joined the old flight">((r) => setTimeout(() => r("joined the old flight"), 1000))]);
    open();
    await oldFlight;
    assert.ok(typeof newer !== "string" && newer.ok, JSON.stringify(newer));
    assert.equal(await fs.readFile(newer.file, "utf8"), "new zip");
    assert.ok(newer.file.includes(`${path.sep}${VERSION}${path.sep}`), newer.file);
  });

  it("refuses a file that declares itself over the size cap, without reading it", async (t) => {
    captureConsole(t, "warn");
    const bytes = Buffer.alloc(10_000, 7);
    release.publish(ZIP.name, bytes);
    release.files.get(`/v${VERSION}/${ZIP.name}`)!.headers = { "content-length": "10000" };
    const r = await make({ maxZipBytes: 9_999 }).resolve(ZIP);
    assert.ok(!r.ok);
    assert.equal(r.status, 502);
    assert.match(r.message, /over the 9999 byte limit/);
    assert.equal(release.count(".zip"), 1, "the zip is asked for, and its body is never read");
    // The published checksum is good and may stay; the zip and any partial file may not.
    assert.deepEqual(await listCache(), [SUM.name]);
  });

  it("refuses a file that goes past the cap while streaming, and leaves no partial file", async (t) => {
    captureConsole(t, "warn");
    // No content-length: the response is chunked and only the count can catch it.
    const bytes = Buffer.alloc(40_000, 9);
    release.publish(ZIP.name, bytes);
    const real = release.fetch;
    release.fetch = async (input, init) => {
      const res = await real(input, init);
      if (!String(input).endsWith(".zip")) return res;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 8_000) c.enqueue(new Uint8Array(bytes.subarray(i, i + 8_000)));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    };
    const r = await make({ maxZipBytes: 20_000 }).resolve(ZIP);
    assert.ok(!r.ok);
    assert.equal(r.status, 502);
    assert.match(r.message, /went past the 20000 byte limit/);
    assert.deepEqual(await listCache(), [SUM.name], "no zip and no partial file");
  });

  // An explicit timeout: a regression that ignores the abort signal would otherwise
  // leave this awaiting a fetch that never settles, and hang the run instead of failing it.
  it("gives up on a transfer that stalls, and tries again on the next request", { timeout: 5000 }, async (t) => {
    captureConsole(t, "warn");
    release.publish(ZIP.name, Buffer.from("zip"));
    const real = release.fetch;
    let stall = true;
    release.fetch = (input, init) =>
      stall && String(input).endsWith(".zip")
        ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
        : real(input, init);
    const dl = make({ zipIdleMs: 30 });

    const r = await dl.resolve(ZIP);
    assert.ok(!r.ok);
    assert.equal(r.status, 404);

    stall = false;
    const again = await dl.resolve(ZIP);
    assert.ok(again.ok, JSON.stringify(again));
  });

  it("never shows a half-downloaded zip under its real name", { timeout: 5000 }, async (t) => {
    captureConsole(t, "log", "warn");
    const first = Buffer.alloc(30_000, 1);
    const rest = Buffer.alloc(30_000, 2);
    release.publish(ZIP.name, Buffer.concat([first, rest]));
    // A body the test holds open: one chunk now, the rest when it says.
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const real = release.fetch;
    release.fetch = async (input, init) => {
      if (!String(input).endsWith(".zip")) return real(input, init);
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => { body = c; c.enqueue(new Uint8Array(first)); } }), { status: 200 });
    };
    const flight = make().resolve(ZIP);
    const partName = async () => (await fs.readdir(cacheDir()).catch(() => [] as string[])).find((n) => n.endsWith(".part"));
    for (let i = 0; i < 200 && !(await partName().then(async (n) => n && (await fs.stat(path.join(cacheDir(), n))).size > 0)); i++) await new Promise((r) => setTimeout(r, 10));

    // Mid-download: the bytes are on disk, but not under the name a request serves.
    assert.ok(await partName(), "the download is being written to a .part file");
    assert.ok(!(await listCache()).includes(ZIP.name), "the final name must not exist until the file is whole and checked");

    body.enqueue(new Uint8Array(rest));
    body.close();
    const r = await flight;
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(await listCache(), [ZIP.name, SUM.name], "whole now, under its real name, and no .part left");
  });

  it("leaves no zip, whole or partial, when the connection drops mid-body", { timeout: 5000 }, async (t) => {
    captureConsole(t, "warn");
    release.publish(ZIP.name, Buffer.alloc(60_000, 3));
    const real = release.fetch;
    release.fetch = async (input, init) => {
      if (!String(input).endsWith(".zip")) return real(input, init);
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new Uint8Array(30_000)); c.error(new Error("connection reset")); } }), { status: 200 });
    };
    const r = await make().resolve(ZIP);
    assert.ok(!r.ok);
    assert.match(r.message, /did not finish downloading: connection reset/);
    assert.deepEqual(await listCache(), [SUM.name]);
  });

  describe("the release record's size cap", () => {
    const CAP = 1024 * 1024;
    /** A valid record, padded with trailing whitespace to exactly `length` bytes. */
    const recordOf = (length: number) => {
      const json = Buffer.from(JSON.stringify({ assets: [{ name: ZIP.name, digest: `sha256:${sha(Buffer.from("zip bytes"))}` }] }));
      return Buffer.concat([json, Buffer.alloc(length - json.length, 0x20)]);
    };

    it("refuses a record over 1 MiB, even when it parses and lists a good digest", async (t) => {
      captureConsole(t, "warn");
      release.record = { body: recordOf(CAP + 1) };
      const r = await make().resolve(SUM);
      assert.ok(!r.ok);
      assert.equal(r.status, 502);
      assert.match(r.message, /the release record for v1\.2\.3-beta\.4 is larger than 1048576 bytes; refusing it/);
      assert.deepEqual(await listCache(), [], "nothing is stored");
    });

    it("accepts one of exactly 1 MiB", async (t) => {
      captureConsole(t, "log", "warn");
      release.record = { body: recordOf(CAP) };
      assert.ok((await make().resolve(SUM)).ok);
    });
  });

  it("reads the running version once per request, however many steps the request takes", async (t) => {
    captureConsole(t, "log", "warn");
    release.publish(ZIP.name, crypto.randomBytes(1000));
    let reads = 0;
    const dl = make({ version: () => (reads++, VERSION) });
    // A cold request: the checksum, the zip, the pruning after it.
    assert.ok((await dl.resolve(ZIP)).ok);
    assert.equal(reads, 1, "cold: package.json is read once, not once per use");
    assert.ok((await dl.resolve(ZIP)).ok);
    assert.equal(reads, 2, "a cache hit is one read");
    assert.ok(!(await dl.resolve(parseHelperPath("/kiosk/StageUtilityOutput-x86_64.zip") as HelperAsset)).ok);
    assert.equal(reads, 3, "a refusal is one read");
  });

  describe("a transfer that is slow but healthy, and one that is not", () => {
    /** A clock the test moves. The watchdog's timers run on it, so how long a
     *  transfer takes is a number the test chooses, not a wait a loaded machine can
     *  stretch: three of these tests failed under full-suite load when they slept
     *  for real. Nothing here waits. */
    const fakeClock = () => {
      let now = 0;
      let nextId = 0;
      const live = new Map<number, { at: number; fn: () => void }>();
      const timers: WatchdogTimers = {
        setTimeout: (fn, ms) => {
          const id = nextId++;
          live.set(id, { at: now + ms, fn });
          return { id, unref: () => undefined } as unknown as NodeJS.Timeout;
        },
        clearTimeout: (timer) => void live.delete((timer as unknown as { id: number }).id),
      };
      /** Move time on, firing each timer that falls due, in order. */
      const advance = (ms: number) => {
        const end = now + ms;
        for (;;) {
          const due = [...live.entries()].filter(([, v]) => v.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
          if (!due) break;
          live.delete(due[0]);
          now = due[1].at;
          due[1].fn();
        }
        now = end;
      };
      return { timers, advance };
    };

    /** The zip's reply: `chunks` chunks `gapMs` apart on the fake clock, then the
     *  end, or silence for ever when `endless`. The stream errors when the
     *  request's signal aborts, as a real fetch body does. */
    const slowZip = (clock: ReturnType<typeof fakeClock>, chunks: number, gapMs: number, opts: { endless?: boolean } = {}) => {
      const real = release.fetch;
      release.fetch = async (input, init) => {
        if (!String(input).endsWith(".zip")) return real(input, init);
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
          },
          async pull(c) {
            if (sent >= chunks && opts.endless) {
              // Silence: time passes, nothing arrives, until the watchdog aborts.
              while (!init?.signal?.aborted) {
                clock.advance(gapMs);
                await Promise.resolve();
              }
              return;
            }
            clock.advance(gapMs);
            if (init?.signal?.aborted) return;
            if (sent >= chunks) c.close();
            else c.enqueue(new Uint8Array(100).fill(sent++ + 1));
          },
        });
        return new Response(stream, { status: 200 });
      };
    };
    const publishedFor = (chunks: number) => {
      const bytes = Buffer.concat(Array.from({ length: chunks }, (_, i) => Buffer.alloc(100, i + 1)));
      release.publish(ZIP.name, bytes);
      return bytes;
    };

    it("lets a slow transfer finish when it keeps moving, though it takes far longer than the idle limit", { timeout: 5000 }, async (t) => {
      captureConsole(t, "log", "warn");
      // 1.2 s of fake time in all against a 400 ms idle limit: each gap is far
      // inside the limit, the total is three times it, which is what this proves.
      const bytes = publishedFor(16);
      const clock = fakeClock();
      slowZip(clock, 16, 75);
      const r = await make({ zipIdleMs: 400, zipTotalMs: 10_000, watchdogTimers: clock.timers }).resolve(ZIP);
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepEqual(await fs.readFile(r.file), bytes);
    });

    it("gives up on a transfer that goes quiet part-way, and leaves nothing but the checksum", { timeout: 5000 }, async (t) => {
      captureConsole(t, "warn");
      publishedFor(6);
      const clock = fakeClock();
      slowZip(clock, 2, 20, { endless: true });
      const r = await make({ zipIdleMs: 100, zipTotalMs: 10_000, watchdogTimers: clock.timers }).resolve(ZIP);
      assert.ok(!r.ok);
      assert.equal(r.status, 502);
      assert.match(r.message, /did not finish downloading: no data for 0\.1 s/);
      assert.deepEqual(await listCache(), [SUM.name], "no zip and no partial file");
    });

    it("stops a transfer that trickles for ever at the ceiling", { timeout: 5000 }, async (t) => {
      captureConsole(t, "warn");
      publishedFor(6);
      const clock = fakeClock();
      slowZip(clock, 1_000_000, 20); // never idle for 200 ms, never ends
      const r = await make({ zipIdleMs: 200, zipTotalMs: 250, watchdogTimers: clock.timers }).resolve(ZIP);
      assert.ok(!r.ok);
      assert.match(r.message, /did not finish downloading: still going after 0\.25 s/);
      assert.deepEqual(await listCache(), [SUM.name]);
    });
  });

  describe("a cached zip that is damaged on disk", () => {
    const zipPath = () => path.join(cacheDir(), ZIP.name);
    /** The same size, different bytes, as a flipped bit on disk would leave it. */
    const corrupt = async (keepStamp: boolean, at = 10) => {
      const before = await fs.stat(zipPath());
      const bytes = await fs.readFile(zipPath());
      bytes[at] ^= 0xff;
      await fs.writeFile(zipPath(), bytes);
      if (keepStamp) await fs.utimes(zipPath(), before.atime, before.mtime);
    };

    it("is dropped and fetched again by a server that has just started, not served", async (t) => {
      const lines = captureConsole(t, "log", "warn");
      const good = crypto.randomBytes(50_000);
      release.publish(ZIP.name, good);
      assert.ok((await make().resolve(ZIP)).ok);
      await corrupt(true);

      const restarted = make(); // a new process: nothing is remembered as verified
      const before = release.count(".zip");
      const r = await restarted.resolve(ZIP);
      assert.ok(r.ok, JSON.stringify(r));
      assert.equal(r.source, "release", "fetched again, not served from the cache");
      assert.equal(release.count(".zip"), before + 1);
      assert.deepEqual(await fs.readFile(r.file), good, "and what is served is the good file");
      assert.ok(lines.some((l) => l.startsWith("[output-helper] the cached StageUtilityOutput-arm64.zip is not trusted (its SHA-256 is ")), lines.join("\n"));
    });

    it("is not hashed again on every hit: a verified file is one stat call, until its size or mtime moves", async (t) => {
      captureConsole(t, "log", "warn");
      const good = crypto.randomBytes(50_000);
      release.publish(ZIP.name, good);
      const dl = make();
      assert.ok((await dl.resolve(ZIP)).ok);
      // Damage that leaves size and mtime exactly as they were: the cost bound this
      // check accepts, and the reason a later hit is cheap. A restart catches it.
      await corrupt(true);
      const cheap = await dl.resolve(ZIP);
      assert.ok(cheap.ok && cheap.source === "cache", "a verified, unchanged file is served without hashing it again");

      // The same damage with a changed mtime is noticed in the very same process.
      await corrupt(false, 20);
      const later = new Date(Date.now() + 60_000);
      await fs.utimes(zipPath(), later, later);
      const before = release.count(".zip");
      const r = await dl.resolve(ZIP);
      assert.ok(r.ok && r.source === "release", JSON.stringify(r));
      assert.equal(release.count(".zip"), before + 1);
      assert.deepEqual(await fs.readFile(r.file), good);
    });

    it("is refetched, with its checksum, when the checksum beside it has gone", async (t) => {
      captureConsole(t, "log", "warn");
      release.publish(ZIP.name, Buffer.from("good zip"));
      assert.ok((await make().resolve(ZIP)).ok);
      await fs.rm(path.join(cacheDir(), SUM.name));
      const r = await make().resolve(ZIP);
      assert.ok(r.ok && r.source === "release", JSON.stringify(r));
      assert.deepEqual(await listCache(), [ZIP.name, SUM.name]);
    });
  });

  it("keeps only the running version's files", async () => {
    const old = path.join(dataDir, "cache", "output-helper", "1.0.0");
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, ZIP.name), "old");
    release.publish(ZIP.name, Buffer.from("current"));
    assert.ok((await make().resolve(ZIP)).ok);
    assert.deepEqual(await fs.readdir(path.join(dataDir, "cache", "output-helper")), [VERSION]);
  });

  it("removes older versions on the first request of the running one, though nothing is fetched", async (t) => {
    const lines = captureConsole(t, "log", "warn");
    release.publish(ZIP.name, Buffer.from("current"));
    assert.ok((await make().resolve(ZIP)).ok); // fills the cache, and prunes: nothing old yet
    const root = path.join(dataDir, "cache", "output-helper");
    await fs.mkdir(path.join(root, "1.0.0"), { recursive: true });
    await fs.writeFile(path.join(root, "1.0.0", ZIP.name), "old zip");
    await fs.mkdir(path.join(root, "0.9.0"), { recursive: true });

    // A new process (an update restarted the server), serving from the cache with no network.
    release.offline = true;
    const asked = release.requests.length;
    const r = await make().resolve(SUM);
    assert.ok(r.ok && r.source === "cache");
    assert.equal(release.requests.length, asked, "nothing was fetched");
    assert.deepEqual((await fs.readdir(root)).sort(), [VERSION], "the old versions are gone");
    assert.ok(lines.some((l) => l === "[output-helper] removed older cached releases: 0.9.0, 1.0.0"), lines.join("\n"));
  });

  describe("pruneOutputHelperCache", () => {
    it("is nothing to do when there is no cache yet", async (t) => {
      const lines = captureConsole(t, "log", "warn");
      assert.deepEqual(await pruneOutputHelperCache(dataDir, VERSION), { removed: [], failed: [] });
      assert.deepEqual(lines, []);
    });

    it("names what it could not remove, and still removes the rest", { skip: process.getuid?.() === 0 && "root ignores a read-only directory" }, async (t) => {
      const lines = captureConsole(t, "log", "warn");
      const root = path.join(dataDir, "cache", "output-helper");
      await fs.mkdir(path.join(root, "1.0.0", "inner"), { recursive: true });
      await fs.mkdir(path.join(root, "2.0.0"), { recursive: true });
      await fs.chmod(path.join(root, "1.0.0"), 0o555); // its contents cannot be removed
      try {
        const r = await pruneOutputHelperCache(dataDir, VERSION);
        assert.deepEqual(r.removed, ["2.0.0"]);
        assert.equal(r.failed.length, 1);
        assert.match(r.failed[0], /^1\.0\.0: /);
        assert.ok(lines.some((l) => l.startsWith("[output-helper] could not remove an older cached release: 1.0.0: ")), lines.join("\n"));
      } finally {
        await fs.chmod(path.join(root, "1.0.0"), 0o755);
      }
    });
  });

  it("does not put the data directory in the reply a LAN client reads", async (t) => {
    captureConsole(t, "warn");
    release.publish(ZIP.name, Buffer.from("zip"));
    // A directory where the cache file must go makes the rename fail with a path in the message.
    await fs.mkdir(path.join(cacheDir(), ZIP.name), { recursive: true });
    const r = await make().resolve(ZIP);
    assert.ok(!r.ok);
    assert.ok(!r.message.includes(dataDir), r.message);
  });
});
