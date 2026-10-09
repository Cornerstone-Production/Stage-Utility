// output-helper-download.ts — the Mac output helper, served by the server it
// installs against.
//
// The app is a few hundred MB because it bundles Chromium, so a Mac on a network
// with no internet has to be able to get it from the server. The server is not
// the source: GitHub's release for the version the server is running is. This
// fetches that asset ONCE, checks it against the checksum the release publishes,
// keeps it under the data directory, and serves it from there from then on.
//
// What is bounded, and why each bound is here:
//   - one fetch at a time per file: two Macs installing together must not start
//     two 300 MB downloads of the same thing;
//   - a size cap: a release host (or whatever answers in its place) that sends
//     more than the helper can possibly weigh is refused, not stored;
//   - a timeout: a transfer that stalls ends, so the next request tries again
//     instead of waiting behind it for ever.
//
// A file reaches the cache only after its digest matched. It is written to a
// temporary name and renamed into place, so a request never sees half a file.
//
// This is a cache, not a store: nothing here is the operator's work, and losing
// it costs one download. It lives under cache/ in the data directory, beside the
// photo cache, and is not part of a config backup.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { withoutDataDir } from "./app-paths.js";
import { commitPart, readCapped, streamToPart } from "./capped-download.js";
import { errorMessage, fetchFailureMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import { atomicWrite } from "./write-queue.js";

export const HELPER_ARCHES = ["arm64", "x86_64"] as const;
export type HelperArch = (typeof HELPER_ARCHES)[number];

/** A file this module will serve: the zip for one architecture, or its checksum. */
export interface HelperAsset {
  arch: HelperArch;
  kind: "zip" | "sha256";
  /** The file's name, which is also its name on the release and in the cache. */
  name: string;
}

const REPO = "Cornerstone-Production/Stage-Utility";
const DEFAULT_RELEASE_BASE = `https://github.com/${REPO}/releases/download`;

/** Names the request path may carry. An allowlist, because the name ends up in a
 *  file path and in an outgoing URL. */
const PATH_RE = /^\/kiosk\/(StageUtilityOutput-(arm64|x86_64)\.zip)(\.sha256)?$/;

/** The asset a request path names, or null when it names none of them. */
export function parseHelperPath(pathname: string): HelperAsset | null {
  const m = PATH_RE.exec(pathname);
  if (!m) return null;
  const arch = m[2] as HelperArch;
  return m[3] ? { arch, kind: "sha256", name: `${m[1]}.sha256` } : { arch, kind: "zip", name: m[1] };
}

/** The most the app can weigh. The Chromium framework is nearly all of it and a
 *  zip is a good deal under the bundle's 320 MB; this is the ceiling, not the
 *  expectation. */
const DEFAULT_MAX_ZIP_BYTES = 1024 * 1024 * 1024;
/** A checksum file is one line. */
const MAX_SUM_BYTES = 4 * 1024;
const DEFAULT_ZIP_TIMEOUT_MS = 30 * 60 * 1000;
const SUM_TIMEOUT_MS = 15 * 1000;
/** A leftover temporary file older than this belongs to a fetch that died. */
const STALE_PART_MS = 60 * 60 * 1000;

export type Resolution =
  | { ok: true; file: string; size: number; source: "cache" | "release" }
  | { ok: false; status: 404 | 502; message: string };

export interface DownloadDeps {
  /** The data directory; the cache lives in its cache/output-helper. */
  dataDir: () => string;
  /** The running release's version, as in package.json: "1.26.0-beta.4". */
  version: () => string;
  fetch?: typeof fetch;
  /** Where release assets are fetched from. Tests only; see releaseBase(). */
  releaseBase?: () => string;
  maxZipBytes?: number;
  zipTimeoutMs?: number;
  sumTimeoutMs?: number;
}

/**
 * Where release assets come from: GitHub, unless the test hook says otherwise.
 *
 * STAGE_UTILITY_TEST_RELEASE_BASE exists so a test can stand a local HTTP server
 * in for GitHub. It is not an operator setting and is not documented as one; an
 * unset variable, which is every real install, means GitHub.
 */
export function releaseBase(): string {
  const base = process.env.STAGE_UTILITY_TEST_RELEASE_BASE?.trim();
  if (!base) return DEFAULT_RELEASE_BASE;
  if (!testHookAnnounced) {
    testHookAnnounced = true;
    console.warn("[output-helper] fetching releases from STAGE_UTILITY_TEST_RELEASE_BASE, a test hook");
  }
  return base.replace(/\/+$/, "");
}
let testHookAnnounced = false;

/** The digest on a checksum file's first line: `shasum -a 256` prints
 *  "<hex>  <file>", and a bare hex digest is accepted too. */
export function parseChecksum(text: string): string | null {
  const m = /^([0-9a-fA-F]{64})(?:\s|$)/.exec(text.trimStart());
  return m ? m[1].toLowerCase() : null;
}

/** Thrown for a failure whose reply is already decided; anything else thrown
 *  inside a fetch is turned into a 502 at the one place that catches. */
class Refusal extends Error {
  constructor(
    readonly status: 404 | 502,
    message: string,
  ) {
    super(message);
  }
}

export class OutputHelperDownloads {
  /** One flight per file name. A Map, not an object: the key is request-derived. */
  private readonly inflight = new Map<string, Promise<Resolution>>();
  private readonly doFetch: typeof fetch;
  private readonly maxZipBytes: number;
  private readonly zipTimeoutMs: number;
  private readonly sumTimeoutMs: number;
  private readonly base: () => string;

  constructor(private readonly deps: DownloadDeps) {
    this.doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.maxZipBytes = deps.maxZipBytes ?? DEFAULT_MAX_ZIP_BYTES;
    this.zipTimeoutMs = deps.zipTimeoutMs ?? DEFAULT_ZIP_TIMEOUT_MS;
    this.sumTimeoutMs = deps.sumTimeoutMs ?? SUM_TIMEOUT_MS;
    this.base = deps.releaseBase ?? releaseBase;
  }

  /** The file to send for this request, fetching it first when there is none. */
  async resolve(asset: HelperAsset): Promise<Resolution> {
    const r = await this.ensure(asset);
    if (r.ok && r.source === "cache") {
      console.log(`[output-helper] serving ${scrub(asset.name)} from the cache (${scrub(r.size)} bytes)`);
    }
    return r;
  }

  private root(): string {
    return path.join(this.deps.dataDir(), "cache", "output-helper");
  }

  private versionDir(): string {
    return path.join(this.root(), this.deps.version());
  }

  private ensure(asset: HelperAsset): Promise<Resolution> {
    const running = this.inflight.get(asset.name);
    if (running) return running;
    const flight = this.cachedOrFetch(asset).finally(() => this.inflight.delete(asset.name));
    this.inflight.set(asset.name, flight);
    return flight;
  }

  private async cachedOrFetch(asset: HelperAsset): Promise<Resolution> {
    const file = path.join(this.versionDir(), asset.name);
    try {
      const have = await statFile(file);
      if (have !== null) return { ok: true, file, size: have, source: "cache" };
      return asset.kind === "sha256" ? await this.fetchChecksum(asset, file) : await this.fetchZip(asset, file);
    } catch (err) {
      const refusal =
        err instanceof Refusal
          ? err
          : new Refusal(502, `could not store ${asset.name}: ${scrub(errorMessage(err))}`);
      // The message is built from our own words, the version and an error text
      // whose paths are reduced to the data folder before a LAN client sees it.
      console.warn(`[output-helper] ${scrub(asset.name)} failed: ${scrub(refusal.message)}`);
      return { ok: false, status: refusal.status, message: this.forClient(refusal.message) };
    }
  }

  /** A reply a LAN client reads: no filesystem path of the data directory. */
  private forClient(message: string): string {
    return withoutDataDir(message, this.deps.dataDir());
  }

  private url(name: string): string {
    return `${this.base()}/v${this.deps.version()}/${name}`;
  }

  private async get(name: string, timeoutMs: number): Promise<Response> {
    const url = this.url(name);
    let res: Response;
    try {
      res = await this.doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "stage-utility-output-helper" } });
    } catch (err) {
      throw new Refusal(
        404,
        `v${this.deps.version()} of ${name} is not in the cache and could not be fetched: ${fetchFailureMessage(err, "the release host")}`,
      );
    }
    if (res.status === 404) {
      throw new Refusal(404, `the release for v${this.deps.version()} has no ${name}`);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new Refusal(502, `the release host answered ${res.status} for ${name}`);
    }
    return res;
  }

  private async fetchChecksum(asset: HelperAsset, file: string): Promise<Resolution> {
    const zipName = asset.name.replace(/\.sha256$/, "");
    const res = await this.get(asset.name, this.sumTimeoutMs);
    const body = await readCapped(res, MAX_SUM_BYTES);
    if (!body) throw new Refusal(502, `${asset.name} is larger than ${MAX_SUM_BYTES} bytes; refusing it`);
    const text = body.toString("utf8");
    const digest = parseChecksum(text);
    if (!digest) throw new Refusal(502, `${asset.name} does not start with a SHA-256 digest`);
    // Normalised to `shasum` form, which is what the installer's check reads.
    const line = `${digest}  ${zipName}\n`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, line, { mode: 0o644 });
    console.log(`[output-helper] fetched ${scrub(asset.name)} from the release`);
    return { ok: true, file, size: Buffer.byteLength(line), source: "release" };
  }

  private async fetchZip(asset: HelperAsset, file: string): Promise<Resolution> {
    const sumName = `${asset.name}.sha256`;
    const sumFile = path.join(this.versionDir(), sumName);
    // The checksum first, and through the same one-flight path, so a Mac that
    // asks for it while the zip is downloading does not start a second fetch.
    const sum = await this.ensure({ arch: asset.arch, kind: "sha256", name: sumName });
    // Its own reason, unprefixed: the zip is not fetched without it, and the
    // checksum's message already says what was missing and why.
    if (!sum.ok) throw new Refusal(sum.status, sum.message);
    const expected = parseChecksum(await fs.readFile(sumFile, "utf8"));
    if (!expected) throw new Refusal(502, `the cached ${sumName} is not a SHA-256 digest`);

    const res = await this.get(asset.name, this.zipTimeoutMs);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxZipBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Refusal(502, `${asset.name} is ${declared} bytes, over the ${this.maxZipBytes} byte limit; refusing it`);
    }

    const dir = this.versionDir();
    await fs.mkdir(dir, { recursive: true });
    const stale = await sweepParts(dir);
    for (const failed of stale) console.warn(`[output-helper] could not remove a leftover partial download: ${scrub(failed)}`);
    const part = path.join(dir, `${asset.name}.${process.pid}-${crypto.randomUUID()}.part`);
    const hash = crypto.createHash("sha256");
    let size: number;
    try {
      if (!res.body) throw new Refusal(502, `${asset.name} came with no body`);
      const written = await streamToPart(res.body, part, {
        maxBytes: this.maxZipBytes,
        exclusive: true,
        mode: 0o644,
        onChunk: (chunk) => void hash.update(chunk),
      });
      if (!written.ok) throw new Refusal(502, `${asset.name} went past the ${this.maxZipBytes} byte limit; refusing it`);
      size = written.bytes;
      const got = hash.digest("hex");
      if (got !== expected) {
        // Neither file stays: the zip is wrong, and the checksum that said so may
        // be the wrong half, so the next request starts both again.
        await fs.rm(sumFile, { force: true });
        throw new Refusal(502, `${asset.name} did not match its published SHA-256 (expected ${expected}, got ${got}); not stored`);
      }
      await commitPart(part, file);
    } catch (err) {
      await fs.rm(part, { force: true });
      if (err instanceof Refusal) throw err;
      // A timeout or a dropped connection mid-body: the download did not finish.
      throw new Refusal(502, `${asset.name} did not finish downloading: ${fetchFailureMessage(err, "the release host")}`);
    }
    console.log(`[output-helper] fetched ${scrub(asset.name)} from the release and verified its SHA-256 (${scrub(size)} bytes)`);
    const removed = await this.dropOtherVersions();
    for (const failed of removed) console.warn(`[output-helper] could not remove an older cached release: ${scrub(failed)}`);
    return { ok: true, file, size, source: "release" };
  }

  /** The cache holds the running version only; an older release's zip is
   *  hundreds of MB nobody will ask for again. Returns what it could not remove. */
  private async dropOtherVersions(): Promise<string[]> {
    const failed: string[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(this.root());
    } catch (err) {
      return [errorMessage(err)];
    }
    for (const entry of entries) {
      if (entry === this.deps.version()) continue;
      try {
        await fs.rm(path.join(this.root(), entry), { recursive: true, force: true });
      } catch (err) {
        failed.push(`${entry}: ${errorMessage(err)}`);
      }
    }
    return failed;
  }
}

async function statFile(file: string): Promise<number | null> {
  try {
    const st = await fs.stat(file);
    return st.isFile() && st.size > 0 ? st.size : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Remove partial downloads left by a fetch that died. Returns what it could not. */
async function sweepParts(dir: string): Promise<string[]> {
  const failed: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    return [errorMessage(err)];
  }
  for (const name of names) {
    if (!name.endsWith(".part")) continue;
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (Date.now() - st.mtimeMs > STALE_PART_MS) await fs.rm(file, { force: true });
    } catch (err) {
      failed.push(`${name}: ${errorMessage(err)}`);
    }
  }
  return failed;
}
