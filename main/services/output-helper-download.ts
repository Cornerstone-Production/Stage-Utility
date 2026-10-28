// output-helper-download.ts — the Mac output helper, served by the server it
// installs against.
//
// The app is a few hundred MB because it bundles Chromium, so a Mac on a network
// with no internet has to be able to get it from the server. The server is not
// the source: GitHub's release for the version the server is running is. This
// fetches that asset ONCE, checks it against the digest GitHub's releases API
// serves for it (the same per-asset digest the app's own installers verify their
// tarballs against), keeps it under the data directory, and serves it from there
// from then on.
//
// What is bounded, and why each bound is here:
//   - one fetch at a time per file: two Macs installing together must not start
//     two 300 MB downloads of the same thing;
//   - a size cap: a release host (or whatever answers in its place) that sends
//     more than the helper can possibly weigh is refused, not stored; the
//     release's JSON, which carries the digest, has its own much smaller cap;
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
// The digest is cached per version beside the zip, as the one `shasum` line the
// installer reads from /kiosk/<zip>.sha256, so a restart does not ask the API
// again. There is no .sha256 file on the release; the server builds that line.
// A release with no digest for the asset is refused with that reason, never
// verified some other way.
//
// Each payload a machine updates itself from also has a signature on the release,
// `<payload>.sig`, made in CI with a key this server never has (see
// release-signing-key.ts): one per helper zip, and one for the Windows kiosk's
// launcher, which the server serves from its own tree. The server fetches each
// once, checks it against the digest the release lists for it, the same way as
// the zip, caches it beside the zip and serves it as it is. It does not judge the
// signature: the machine does, against the key it was installed with. A release
// with no signature asset is a 404, and the machine then refuses the update.
//
// This is a cache, not a store: nothing here is the operator's work, and losing
// it costs one download. It lives under cache/ in the data directory, beside the
// photo cache, and is not part of a config backup.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { withoutDataDir } from "./app-paths.js";
import { commitPart, downloadWatchdog, readCapped, sha256OfFile, streamToPart, type WatchdogTimers } from "./capped-download.js";
import { errorMessage, fetchFailureMessage, isNotFound } from "./errors.js";
import { GITHUB_API_REPO, GITHUB_RELEASE_DOWNLOAD, rateLimitMessage } from "./github-repo.js";
import { scrub } from "./scrub.js";
import { atomicWrite } from "./write-queue.js";
import { isRecord } from "./is-record.js";

export const HELPER_ARCHES = ["arm64", "x86_64"] as const;
export type HelperArch = (typeof HELPER_ARCHES)[number];

/**
 * A file this module will serve: the zip for one architecture, its checksum line,
 * or the release's signature of a payload. `name` is the file's name, which is
 * also its name in the cache. The zip and a signature are also their names on the
 * release; the checksum line is built here and is not a release asset.
 */
export type HelperAsset =
  | { kind: "zip" | "sha256"; arch: HelperArch; name: string }
  | { kind: "sig"; name: string };

/** The zip or its checksum line: the assets that belong to one architecture. */
type ArchAsset = Extract<HelperAsset, { arch: HelperArch }>;

/** Every file this route serves, by name. The request path is only ever compared
 *  with these: the name that goes into the cache path and the outgoing URL is the
 *  table's own string, never text taken from the request. */
const HELPER_ASSETS: readonly HelperAsset[] = [
  ...HELPER_ARCHES.flatMap((arch): HelperAsset[] => [
    { arch, kind: "zip", name: `StageUtilityOutput-${arch}.zip` },
    { arch, kind: "sha256", name: `StageUtilityOutput-${arch}.zip.sha256` },
    { kind: "sig", name: `StageUtilityOutput-${arch}.zip.sig` },
  ]),
  // The Windows kiosk's launcher is served from scripts/kiosk, not the release;
  // only its signature comes from there.
  { kind: "sig", name: "kiosk-windows.ps1.sig" },
];

/** The asset a request path names, or null when it names none of them. */
export function parseHelperPath(pathname: string): HelperAsset | null {
  return HELPER_ASSETS.find((a) => pathname === `/kiosk/${a.name}`) ?? null;
}

/** The most the app can weigh. The Chromium framework is nearly all of it and a
 *  zip is a good deal under the bundle's 320 MB; this is the ceiling, not the
 *  expectation. */
const DEFAULT_MAX_ZIP_BYTES = 1024 * 1024 * 1024;
/** A release's JSON: its notes and one object per asset, some tens of KB; this is
 *  headroom, not the expectation. */
const MAX_RELEASE_JSON_BYTES = 1024 * 1024;
/** No bytes for this long (the connect and the response headers count) and the zip
 *  transfer is given up on. A slow link that keeps moving never trips it. */
const DEFAULT_ZIP_IDLE_MS = 60 * 1000;
/** The outright ceiling, for a host that trickles just fast enough never to go
 *  idle. About 145 MB per architecture, so this is ~20 kB/s. */
const DEFAULT_ZIP_TOTAL_MS = 2 * 60 * 60 * 1000;
const DIGEST_TIMEOUT_MS = 15 * 1000;
/** An RSA-3072 signature is 384 bytes; this is headroom, not the expectation. */
const MAX_SIG_BYTES = 16 * 1024;
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
  /** Where the release's zips and its API record are fetched from. Tests only;
   *  see releaseHosts(). */
  releaseHosts?: () => ReleaseHosts;
  maxZipBytes?: number;
  zipIdleMs?: number;
  zipTotalMs?: number;
  /** Replaces the timers behind the idle limit and the ceiling. Tests only: a
   *  test moves time itself instead of waiting for it. */
  watchdogTimers?: WatchdogTimers;
  /** The most the releases API call may take. */
  digestTimeoutMs?: number;
}

export interface ReleaseHosts {
  /** Where a release's assets download from: `<download>/v<version>/<name>`. */
  download: string;
  /** Where a release's JSON is read from: `<api>/v<version>`. */
  api: string;
}

/**
 * Where release assets and their digests come from: GitHub, unless the test hook
 * says otherwise.
 *
 * STAGE_UTILITY_TEST_RELEASE_BASE exists so a test can stand a local HTTP server
 * in for GitHub. Assets are served from its root and the releases API from
 * `<base>/api/releases/tags`, so one variable can never leave one half of the
 * fetch pointed at the real GitHub. It is not an operator setting and is not
 * documented as one; an unset variable, which is every real install, means GitHub.
 */
export function releaseHosts(): ReleaseHosts {
  const base = process.env.STAGE_UTILITY_TEST_RELEASE_BASE?.trim();
  if (!base) return { download: GITHUB_RELEASE_DOWNLOAD, api: `${GITHUB_API_REPO}/releases/tags` };
  if (!testHookAnnounced) {
    testHookAnnounced = true;
    console.warn("[output-helper] fetching releases from STAGE_UTILITY_TEST_RELEASE_BASE, a test hook");
  }
  const root = base.replace(/\/+$/, "");
  return { download: root, api: `${root}/api/releases/tags` };
}
let testHookAnnounced = false;

/** The digest at the start of a checksum line: `shasum -a 256` prints
 *  "<hex>  <file>", and a bare hex digest is accepted too. Reads the line this
 *  server caches. */
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

/**
 * The hex SHA-256 in the `digest` of the asset named exactly `assetName` in a
 * release's JSON (GitHub writes it "sha256:<64 hex>"). Throws a Refusal that says
 * which part is missing: 404 when the release does not list the asset, 502 when it
 * answered with something that cannot be verified against.
 */
export function assetDigest(body: string, version: string, assetName: string): string {
  let release: unknown;
  try {
    release = JSON.parse(body);
  } catch {
    throw new Refusal(502, `the release record for v${version} is not JSON`);
  }
  const assets = isRecord(release) ? release.assets : undefined;
  if (!Array.isArray(assets)) throw new Refusal(502, `the release record for v${version} lists no assets array`);
  const asset: unknown = assets.find((a) => isRecord(a) && a.name === assetName);
  if (!isRecord(asset)) throw new Refusal(404, `the release for v${version} has no ${assetName}`);
  const digest = asset.digest;
  if (digest === undefined || digest === null || digest === "") {
    throw new Refusal(
      502,
      `the release for v${version} lists ${assetName} with no digest (GitHub only began serving asset digests in 2025, so an older release has none); it cannot be verified`,
    );
  }
  const m = typeof digest === "string" ? /^sha256:([0-9a-fA-F]{64})$/.exec(digest) : null;
  if (!m) throw new Refusal(502, `the digest GitHub lists for ${assetName} in v${version} is not a SHA-256 ("sha256:" and 64 hex digits)`);
  return m[1].toLowerCase();
}

/** Where the helper's cached releases live: one directory per version. */
function cacheRoot(dataDir: string): string {
  return path.join(dataDir, "cache", "output-helper");
}

export class OutputHelperDownloads {
  /** One flight per file name. A Map, not an object: the key is request-derived. */
  private readonly inflight = new Map<string, Promise<Resolution>>();
  private readonly doFetch: typeof fetch;
  private readonly maxZipBytes: number;
  private readonly zipIdleMs: number;
  private readonly zipTotalMs: number;
  private readonly digestTimeoutMs: number;
  private readonly hosts: () => ReleaseHosts;
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
    this.digestTimeoutMs = deps.digestTimeoutMs ?? DIGEST_TIMEOUT_MS;
    this.hosts = deps.releaseHosts ?? releaseHosts;
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

  private versionDir(version: string): string {
    return path.join(cacheRoot(this.deps.dataDir()), version);
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
      if (have !== null && (asset.kind !== "zip" || (await this.zipStillMatches(file, have, version, asset)))) {
        return { ok: true, file, size: have.size, source: "cache" };
      }
      if (asset.kind === "sig") return await this.fetchSignature(asset, file, version);
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
    const why = expected ? `its SHA-256 is ${got}, not the release's ${expected}` : "its checksum is missing or unreadable";
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

  /**
   * One GET of the release host, for the zip or for the release's record, with the
   * same answer to each outcome: unreachable is a 404 (the Mac may try GitHub
   * itself), a missing release or asset is a 404, anything else that is not a 200 a
   * 502 that says when it is GitHub's rate limit. `zipName` is the asset this
   * request is for, `subject` what is being fetched, `missing` what a 404 means.
   */
  private async get(url: string, o: { zipName: string; version: string; subject: string; missing: string; signal: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
    let res: Response;
    try {
      res = await this.doFetch(url, { signal: o.signal, headers: { "User-Agent": "stage-utility-output-helper", ...o.headers } });
    } catch (err) {
      throw new Refusal(404, `v${o.version} of ${o.zipName} is not in the cache and could not be fetched: ${fetchFailureMessage(err, "the release host")}`);
    }
    if (res.status === 200) return res;
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) throw new Refusal(404, o.missing);
    const limit = rateLimitMessage(res);
    throw new Refusal(502, `the release host answered ${res.status} for ${o.subject}${limit ? ` (${limit})` : ""}`);
  }

  private getZip(name: string, version: string, signal: AbortSignal): Promise<Response> {
    return this.get(`${this.hosts().download}/v${version}/${name}`, {
      zipName: name,
      version,
      subject: name,
      missing: `the release for v${version} has no ${name}`,
      signal,
    });
  }

  private getRelease(zipName: string, version: string, signal: AbortSignal): Promise<Response> {
    return this.get(`${this.hosts().api}/v${version}`, {
      zipName,
      version,
      subject: `the release record of v${version}`,
      missing: `there is no release v${version} on GitHub`,
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });
  }

  /** The zip's digest from the releases API, written as the one `shasum` line the
   *  installer reads. This is the only place the release is asked for a digest. */
  private async fetchChecksum(asset: HelperAsset, file: string, version: string): Promise<Resolution> {
    const zipName = asset.name.replace(/\.sha256$/, "");
    const res = await this.getRelease(zipName, version, AbortSignal.timeout(this.digestTimeoutMs));
    const body = await readCapped(res, MAX_RELEASE_JSON_BYTES);
    if (!body) throw new Refusal(502, `the release record for v${version} is larger than ${MAX_RELEASE_JSON_BYTES} bytes; refusing it`);
    // In `shasum` form, which is what the installer's check reads.
    const line = `${assetDigest(body.toString("utf8"), version, zipName)}  ${zipName}\n`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, line, { mode: 0o644 });
    console.log(`[output-helper] read the SHA-256 of ${scrub(zipName)} from the release record for v${scrub(version)}`);
    return { ok: true, file, size: Buffer.byteLength(line), source: "release" };
  }

  /** A payload's signature, fetched from the release and kept only once its
   *  SHA-256 matched the digest the release lists for it, as the zip is. */
  private async fetchSignature(asset: HelperAsset, file: string, version: string): Promise<Resolution> {
    // One limit over the record and the signature together: two small reads.
    const signal = AbortSignal.timeout(this.digestTimeoutMs);
    const record = await readCapped(await this.getRelease(asset.name, version, signal), MAX_RELEASE_JSON_BYTES);
    if (!record) throw new Refusal(502, `the release record for v${version} is larger than ${MAX_RELEASE_JSON_BYTES} bytes; refusing it`);
    // A release that lists no signature is a 404 from here, which the machine
    // reads as "missing" and refuses the update for.
    const expected = assetDigest(record.toString("utf8"), version, asset.name);
    const res = await this.get(`${this.hosts().download}/v${version}/${asset.name}`, {
      zipName: asset.name,
      version,
      subject: asset.name,
      missing: `the release for v${version} has no ${asset.name}`,
      signal,
    });
    let sig: Buffer | null;
    try {
      sig = await readCapped(res, MAX_SIG_BYTES);
    } catch (err) {
      throw new Refusal(502, `${asset.name} did not finish downloading: ${fetchFailureMessage(err, "the release host")}`);
    }
    if (!sig) throw new Refusal(502, `${asset.name} is larger than ${MAX_SIG_BYTES} bytes; refusing it`);
    const got = crypto.createHash("sha256").update(sig).digest("hex");
    if (got !== expected) throw new Refusal(502, `${asset.name} did not match the release's SHA-256 (expected ${expected}, got ${got}); not stored`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, sig, { mode: 0o644 });
    console.log(`[output-helper] fetched ${scrub(asset.name)} from the release for v${scrub(version)} and verified its SHA-256`);
    return { ok: true, file, size: sig.byteLength, source: "release" };
  }

  private async fetchZip(asset: ArchAsset, file: string, version: string): Promise<Resolution> {
    const sumName = `${asset.name}.sha256`;
    const sumFile = path.join(this.versionDir(version), sumName);
    // The digest first, and through the same one-flight path, so a Mac that
    // asks for it while the zip is downloading does not start a second fetch.
    const sum = await this.ensure({ arch: asset.arch, kind: "sha256", name: sumName }, version);
    // Its own reason, unprefixed: the zip is not fetched without it, and the
    // checksum's message already says what was missing and why.
    if (!sum.ok) throw new Refusal(sum.status, sum.message);
    const expected = parseChecksum(await fs.readFile(sumFile, "utf8"));
    if (!expected) throw new Refusal(502, `the cached ${sumName} is not a SHA-256 digest`);

    // Idle watchdog plus a ceiling, over the connect, the headers and the body.
    const watchdog = downloadWatchdog({ idleMs: this.zipIdleMs, totalMs: this.zipTotalMs, timers: this.deps.watchdogTimers });
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
    const res = await this.getZip(asset.name, version, watchdog.signal);
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
        throw new Refusal(502, `${asset.name} did not match the release's SHA-256 (expected ${expected}, got ${got}); not stored`);
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
  const root = cacheRoot(dataDir);
  const removed: string[] = [];
  const failed: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if (!isNotFound(err)) failed.push(errorMessage(err));
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
    if (isNotFound(err)) return null;
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
