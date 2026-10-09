// The Mac output helper's download: fetched from the release once, checked
// against the checksum the release publishes, cached, and served from the cache.
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

import { captureConsole } from "./fixtures/capture-console.js";
import { OutputHelperDownloads, parseChecksum, parseHelperPath, type HelperAsset } from "./output-helper-download.js";

const VERSION = "1.2.3-beta.4";
const ZIP = parseHelperPath("/kiosk/StageUtilityOutput-arm64.zip") as HelperAsset;
const SUM = parseHelperPath("/kiosk/StageUtilityOutput-arm64.zip.sha256") as HelperAsset;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** A stand-in for the release host: what it serves, and what was asked of it. */
class FakeRelease {
  files = new Map<string, { status?: number; body: Buffer; headers?: Record<string, string> }>();
  requests: string[] = [];
  offline = false;
  /** Held until released, so a test can start requests while a fetch is in flight. */
  gate: Promise<void> | null = null;

  publish(name: string, body: Buffer, digest = sha(body)): void {
    this.files.set(`/v${VERSION}/${name}`, { body });
    this.files.set(`/v${VERSION}/${name}.sha256`, { body: Buffer.from(`${digest}  ${name}\n`) });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.requests.push(url.pathname);
    if (this.offline) throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND github.com") });
    if (this.gate) await this.gate;
    init?.signal?.throwIfAborted();
    const file = this.files.get(url.pathname);
    if (!file) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(file.body), { status: file.status ?? 200, headers: file.headers });
  };

  count(suffix: string): number {
    return this.requests.filter((r) => r.endsWith(suffix)).length;
  }
}

let dataDir: string;
let release: FakeRelease;

const make = (extra: Partial<ConstructorParameters<typeof OutputHelperDownloads>[0]> = {}) =>
  new OutputHelperDownloads({ dataDir: () => dataDir, version: () => VERSION, fetch: release.fetch, releaseBase: () => "https://release.test", ...extra });

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
    assert.equal(release.count(".zip.sha256"), 1);

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
    assert.match(r.message, /did not match its published SHA-256/);
    assert.deepEqual(await listCache(), [], "neither the zip, its checksum nor a partial file may be left");
    assert.ok(lines.some((l) => l.startsWith("[output-helper] StageUtilityOutput-arm64.zip failed:")), lines.join("\n"));

    // And it is not remembered as bad or good: the next request tries again.
    const before = release.count(".zip");
    await dl.resolve(ZIP);
    assert.equal(release.count(".zip"), before + 1);
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

  it("answers 404 when the release has no such asset", async (t) => {
    captureConsole(t, "warn");
    const r = await make().resolve(ZIP);
    assert.ok(!r.ok);
    assert.equal(r.status, 404);
    assert.match(r.message, new RegExp(`no ${ZIP.name}.sha256`));
  });

  it("does not fetch the zip when its checksum is unavailable", async (t) => {
    captureConsole(t, "warn");
    release.files.set(`/v${VERSION}/${ZIP.name}`, { body: Buffer.from("zip") });
    const r = await make().resolve(ZIP);
    assert.ok(!r.ok);
    assert.equal(release.count(".zip"), 0, "an unverifiable download must not even start");
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
    assert.equal(release.count(".zip.sha256"), 1, "one fetch of the checksum, shared with the zip's own");
    assert.deepEqual(await listCache(), [ZIP.name, SUM.name]);
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

  it("gives up on a transfer that stalls, and tries again on the next request", async (t) => {
    captureConsole(t, "warn");
    release.publish(ZIP.name, Buffer.from("zip"));
    const real = release.fetch;
    let stall = true;
    release.fetch = (input, init) =>
      stall && String(input).endsWith(".zip")
        ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
        : real(input, init);
    const dl = make({ zipTimeoutMs: 30 });

    const r = await dl.resolve(ZIP);
    assert.ok(!r.ok);
    assert.equal(r.status, 404);

    stall = false;
    const again = await dl.resolve(ZIP);
    assert.ok(again.ok, JSON.stringify(again));
  });

  it("keeps only the running version's files", async () => {
    const old = path.join(dataDir, "cache", "output-helper", "1.0.0");
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, ZIP.name), "old");
    release.publish(ZIP.name, Buffer.from("current"));
    assert.ok((await make().resolve(ZIP)).ok);
    assert.deepEqual(await fs.readdir(path.join(dataDir, "cache", "output-helper")), [VERSION]);
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
