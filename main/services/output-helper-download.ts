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
//   - a stall watchdog and a ceiling: a transfer that goes quiet for a minute ends,
//     so the next request tries again instead of waiting behind it for ever; one
//     that keeps moving, however slowly, is let finish, up to two hours in all;
//   - a re-check of what is cached: a zip is hashed against its checksum again the
//     first time it is served after the server starts, and whenever its size or
//     modification time changes, so a file damaged on disk is dropped and fetched
//     again instead of being served for ever. Later hits are one stat call.
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
import { commitPart, downloadWatchdog, readCapped, sha256OfFile, streamToPart } from "./capped-download.js";
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

/** Every file this route serves, by name. The request path is only ever compared
 *  with these: the name that goes into the cache path and the outgoing URL is the
 *  table's own string, never text taken from the request. */
const HELPER_ASSETS: readonly HelperAsset[] = HELPER_ARCHES.flatMap((arch) => [
  { arch, kind: "zip" as const, name: `StageUtilityOutput-${arch}.zip` },
  { arch, kind: "sha256" as const, name: `StageUtilityOutput-${arch}.zip.sha256` },
]);

/** The asset a request path names, or null when it names none of them. */
export function parseHelperPath(pathname: string): HelperAsset | null {
  return HELPER_ASSETS.find((a) => pathname === `/kiosk/${a.name}`) ?? null;
}

/** The most the app can weigh. The Chromium framework is nearly all of it and a
 *  zip is a good deal under the bundle's 320 MB; this is the ceiling, not the
 *  expectation. */
const DEFAULT_MAX_ZIP_BYTES = 1024 * 1024 * 1024;
/** A checksum file is one line. */
const MAX_SUM_BYTES = 4 * 1024;
/** No bytes for this long (the connect and the response headers count) and the zip
 *  transfer is given up on. A slow link that keeps moving never trips it. */
const DEFAULT_ZIP_IDLE_MS = 60 * 1000;
/** The outright ceiling, for a host that trickles just fast enough never to go
 *  idle. About 145 MB per architecture, so this is ~20 kB/s. */
const DEFAULT_ZIP_TOTAL_MS = 2 * 60 * 60 * 1000;
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
  zipIdleMs?: number;
  zipTotalMs?: number;
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
  private readonly zipIdleMs: number;
  private readonly zipTotalMs: number;
  private readonly sumTimeoutMs: number;
  private readonly base: () => string;
  /** The version whose older siblings were last removed. */
  private prunedFor: string | null = null;
  /** Cached zips this process has hashed since they last changed: path to the
   *  size and mtime they had when they matched. A Map: the path is derived from a
   *  request. */
  private readonly verified = new Map<string, string>();

  constructor(private readonly deps: DownloadDeps) {
    this.doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.maxZipBytes = deps.maxZipBytes ?? DEFAULT_MAX_ZIP_BYTES;
    this.zipIdleMs = deps.zipIdleMs ?? DEFAULT_ZIP_IDLE_MS;
    this.zipTotalMs = deps.zipTotalMs ?? DEFAULT_ZIP_TOTAL_MS;
    this.sumTimeoutMs = deps.sumTimeoutMs ?? SUM_TIMEOUT_MS;
    this.base = deps.releaseBase ?? releaseBase;
  }

  /** The file to send for this request, fetching it first when there is none.
   *  The running version is read ONCE here (it is a synchronous read of
   *  package.json) and carried through everything this request does. */
  async resolve(asset: HelperAsset): Promise<Resolution> {
    const version = this.deps.version();
    await this.pruneOnce(version);
    const r = await this.ensure(asset, version);
    if (r.ok && r.source === "cache") {
      console.log(`[output-helper] serving ${scrub(asset.name)} from the cache (${scrub(r.size)} bytes)`);
    }
    return r;
  }

  /** Older versions are removed on the first request of a running version, so a
   *  server that updated and never fetches (it is offline, or its Macs are done)
   *  still gives the disk back; fetching is not what triggers it. */
  private async pruneOnce(version: string): Promise<void> {
    if (this.prunedFor === version) return;
    this.prunedFor = version;
    await pruneOutputHelperCache(this.deps.dataDir(), version);
  }

  private root(): string {
    return path.join(this.deps.dataDir(), "cache", "output-helper");
  }

  private versionDir(version: string): string {
    return path.join(this.root(), version);
  }

  /** One flight per version and file: a request that arrives mid-update for the
   *  new version must not join a flight that is fetching the old one. */
  private ensure(asset: HelperAsset, version: string): Promise<Resolution> {
    const key = `${version}/${asset.name}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const flight = this.cachedOrFetch(asset, version).finally(() => this.inflight.delete(key));
    this.inflight.set(key, flight);
    return flight;
  }

  private async cachedOrFetch(asset: HelperAsset, version: string): Promise<Resolution> {
    const file = path.join(this.versionDir(version), asset.name);
    try {
      const have = await statFile(file);
      if (have !== null && (asset.kind === "sha256" || (await this.zipStillMatches(file, have, version, asset)))) {
        return { ok: true, file, size: have.size, source: "cache" };
      }
      return asset.kind === "sha256" ? await this.fetchChecksum(asset, file, version) : await this.fetchZip(asset, file, version);
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

  /**
   * Whether a cached zip still hashes to its checksum. Checked the first time it
   * is served after the server starts, and again only when its size or mtime has
   * changed since; a hit that has not changed costs the stat the caller already
   * made. A zip that does not match, or has no checksum left to be checked
   * against, is removed together with its checksum so the caller fetches both
   * again. 145 MB hashes in a second or two once, even on a Pi.
   */
  private async zipStillMatches(file: string, have: FileStamp, version: string, asset: HelperAsset): Promise<boolean> {
    const stamp = stampOf(have);
    if (this.verified.get(file) === stamp) return true;
    const sumFile = path.join(this.versionDir(version), `${asset.name}.sha256`);
    const expected = parseChecksum(await fs.readFile(sumFile, "utf8").catch(() => ""));
    const got = expected ? await sha256OfFile(file) : null;
    if (expected && got === expected) {
      this.verified.set(file, stamp);
      return true;
    }
    const why = expected ? `its SHA-256 is ${got}, not the published ${expected}` : "its checksum is missing or unreadable";
    console.warn(`[output-helper] the cached ${scrub(asset.name)} is not trusted (${scrub(why)}); fetching it again`);
    this.verified.delete(file);
    await fs.rm(file, { force: true });
    await fs.rm(sumFile, { force: true });
    return false;
  }

  /** A reply a LAN client reads: no filesystem path of the data directory. */
  private forClient(message: string): string {
    return withoutDataDir(message, this.deps.dataDir());
  }

  private url(name: string, version: string): string {
    return `${this.base()}/v${version}/${name}`;
  }

  private async get(name: string, version: string, signal: AbortSignal): Promise<Response> {
    const url = this.url(name, version);
    let res: Response;
    try {
      res = await this.doFetch(url, { signal, headers: { "user-agent": "stage-utility-output-helper" } });
    } catch (err) {
      throw new Refusal(
        404,
        `v${version} of ${name} is not in the cache and could not be fetched: ${fetchFailureMessage(err, "the release host")}`,
      );
    }
    if (res.status === 404) {
      throw new Refusal(404, `the release for v${version} has no ${name}`);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new Refusal(502, `the release host answered ${res.status} for ${name}`);
    }
    return res;
  }

  private async fetchChecksum(asset: HelperAsset, file: string, version: string): Promise<Resolution> {
    const zipName = asset.name.replace(/\.sha256$/, "");
    const res = await this.get(asset.name, version, AbortSignal.timeout(this.sumTimeoutMs));
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

  private async fetchZip(asset: HelperAsset, file: string, version: string): Promise<Resolution> {
    const sumName = `${asset.name}.sha256`;
    const sumFile = path.join(this.versionDir(version), sumName);
    // The checksum first, and through the same one-flight path, so a Mac that
    // asks for it while the zip is downloading does not start a second fetch.
    const sum = await this.ensure({ arch: asset.arch, kind: "sha256", name: sumName }, version);
    // Its own reason, unprefixed: the zip is not fetched without it, and the
    // checksum's message already says what was missing and why.
    if (!sum.ok) throw new Refusal(sum.status, sum.message);
    const expected = parseChecksum(await fs.readFile(sumFile, "utf8"));
    if (!expected) throw new Refusal(502, `the cached ${sumName} is not a SHA-256 digest`);

    // Idle watchdog plus a ceiling, over the connect, the headers and the body.
    const watchdog = downloadWatchdog({ idleMs: this.zipIdleMs, totalMs: this.zipTotalMs });
    let size: number;
    try {
      size = await this.downloadZip(asset, file, version, expected, sumFile, watchdog);
    } finally {
      watchdog.stop();
    }
    console.log(`[output-helper] fetched ${scrub(asset.name)} from the release and verified its SHA-256 (${scrub(size)} bytes)`);
    return { ok: true, file, size, source: "release" };
  }

  /** The zip's transfer to its file, hashed on the way, and renamed into place
   *  only when the digest matched. Returns the bytes written. */
  private async downloadZip(
    asset: HelperAsset,
    file: string,
    version: string,
    expected: string,
    sumFile: string,
    watchdog: { signal: AbortSignal; touch: () => void },
  ): Promise<number> {
    const res = await this.get(asset.name, version, watchdog.signal);
    watchdog.touch(); // the headers are data too
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxZipBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Refusal(502, `${asset.name} is ${declared} bytes, over the ${this.maxZipBytes} byte limit; refusing it`);
    }

    const dir = this.versionDir(version);
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
        onChunk: (chunk) => {
          hash.update(chunk);
          watchdog.touch();
        },
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
    // It matched a moment ago: the next hit need not hash it again.
    const st = await fs.stat(file);
    this.verified.set(file, stampOf(st));
    return size;
  }
}

/**
 * The cache holds the running version only; an older release's zips are about
 * 290 MB a version and nobody will ask for them again. Removes every other version
 * directory under cache/output-helper and says which it removed and which it could
 * not, on tagged lines, and returns the same lists. Nothing is thrown: a cache that
 * cannot be tidied is not a reason to refuse a download. No cache yet is nothing to
 * remove.
 */
export async function pruneOutputHelperCache(dataDir: string, keepVersion: string): Promise<{ removed: string[]; failed: string[] }> {
  const root = path.join(dataDir, "cache", "output-helper");
  const removed: string[] = [];
  const failed: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") failed.push(errorMessage(err));
  }
  for (const entry of entries) {
    if (entry === keepVersion) continue;
    try {
      await fs.rm(path.join(root, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch (err) {
      failed.push(`${entry}: ${errorMessage(err)}`);
    }
  }
  if (removed.length > 0) console.log(`[output-helper] removed older cached releases: ${removed.map((r) => scrub(r)).join(", ")}`);
  for (const f of failed) console.warn(`[output-helper] could not remove an older cached release: ${scrub(f)}`);
  return { removed, failed };
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** What "unchanged" means for a verified file: its size and its mtime to the
 *  millisecond, rounded as a Date rounds it (which is what utimes and most tools
 *  restore, and they have nothing finer). */
const stampOf = (st: FileStamp): string => `${st.size}:${Math.round(st.mtimeMs)}`;

async function statFile(file: string): Promise<FileStamp | null> {
  try {
    const st = await fs.stat(file);
    return st.isFile() && st.size > 0 ? { size: st.size, mtimeMs: st.mtimeMs } : null;
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
