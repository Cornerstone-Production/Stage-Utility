// stage-native-modules.ts — put sharp, and the one native build a platform
// needs, into a packaged install's node_modules.
//
// The server is bundled into one file (bundle-server.ts), but sharp cannot be:
// it loads a compiled libvips build for the machine it runs on. So the bundle
// leaves `sharp` as an import, and each archive carries a node_modules/ beside
// server.mjs with sharp, its JavaScript dependencies, and that platform's
// @img/sharp-<platform> (plus @img/sharp-libvips-<platform>; Windows bundles
// libvips inside its package).
//
// Nothing is resolved afresh. Every package is the exact version
// package-lock.json names, downloaded from the URL it names, and refused unless
// its bytes match the lockfile's integrity hash and its package.json the
// lockfile's version. A lockfile that has lost a platform's entry fails here,
// not on a Raspberry Pi after it updated.
//
// Usage: node scripts/stage-native-modules.ts <archive platform> <stage dir>
//   archive platform: linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64 | win-x64

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./is-main.ts";

/** The archive's platform name, as build-artifacts.sh spells it, to npm's. Linux builds are glibc. */
export const SHARP_PLATFORM: Readonly<Record<string, string>> = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "win-x64": "win32-x64",
};

export interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface StagedPackage {
  /** Where it goes under the stage, as the lockfile keys it: node_modules/@img/colour. */
  key: string;
  version: string;
  resolved: string;
  integrity: string;
}

/** The lockfile key a package named `name` resolves to from `from`, the way Node looks it up. */
function resolveKey(lock: Record<string, LockEntry>, from: string, name: string): string | null {
  let base = from;
  for (;;) {
    const key = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (lock[key]) return key;
    if (!base) return null;
    const at = base.lastIndexOf("/node_modules/");
    base = at >= 0 ? base.slice(0, at) : "";
  }
}

/**
 * Every package a packaged install needs for sharp on `platform`: sharp, its
 * dependencies all the way down, and of its optional ones only that
 * platform's native build. Sorted by key. Throws naming what is missing.
 */
export function nativePackages(lock: Record<string, LockEntry>, platform: string): StagedPackage[] {
  const npmPlatform = SHARP_PLATFORM[platform];
  if (!npmPlatform) throw new Error(`unknown platform "${platform}"; one of ${Object.keys(SHARP_PLATFORM).join(", ")}`);
  const wanted = new Set([`@img/sharp-${npmPlatform}`, `@img/sharp-libvips-${npmPlatform}`]);
  const found = new Map<string, StagedPackage>();
  const visit = (key: string) => {
    if (found.has(key)) return;
    const e = lock[key];
    if (!e?.version || !e.resolved || !e.integrity) throw new Error(`package-lock.json has no complete entry for ${key}`);
    found.set(key, { key, version: e.version, resolved: e.resolved, integrity: e.integrity });
    const deps = [...Object.keys(e.dependencies ?? {}), ...Object.keys(e.optionalDependencies ?? {}).filter((n) => wanted.has(n))];
    for (const name of deps) {
      const dep = resolveKey(lock, key, name);
      if (!dep) throw new Error(`package-lock.json has no entry for ${name}, which ${key} needs`);
      visit(dep);
    }
  };
  visit("node_modules/sharp");
  const native = `node_modules/@img/sharp-${npmPlatform}`;
  if (!found.has(native)) throw new Error(`package-lock.json has no ${native}; regenerate it so it lists every platform`);
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Why `bytes` are not the tarball the lockfile's integrity names, or null. */
export function integrityProblem(bytes: Buffer, integrity: string): string | null {
  const [algo, expected] = integrity.split("-", 2);
  if (algo !== "sha512" || !expected) return `unsupported integrity "${integrity.slice(0, 20)}…"`;
  const actual = createHash("sha512").update(bytes).digest("base64");
  return actual === expected ? null : `integrity mismatch: the lockfile says sha512-${expected.slice(0, 16)}…, the download is sha512-${actual.slice(0, 16)}…`;
}

/** The entry names in `list` that could land outside the directory they are
 *  unpacked into: an absolute path, or one with a `..` segment. */
export function unsafeEntries(list: readonly string[]): string[] {
  return list.filter((name) => name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes(".."));
}

/** The entries of a .tgz held in memory, listed by tar from stdin. */
export function tarEntries(tgz: Buffer): string[] {
  const listed = spawnSync("tar", ["-tzf", "-"], { input: tgz, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`tar could not list the archive: ${String(listed.stderr).trim()}`);
  return String(listed.stdout).split("\n").filter(Boolean);
}

/**
 * Unpack a verified .tgz from memory into `dir`, dropping npm's `package/`
 * prefix. Nothing touches the disk before tar does, and an archive with an
 * entry that could escape `dir` is refused before anything is written.
 */
export function unpackInto(tgz: Buffer, dir: string): void {
  const unsafe = unsafeEntries(tarEntries(tgz));
  if (unsafe.length > 0) throw new Error(`the archive has entries outside its folder: ${unsafe.slice(0, 3).join(", ")}`);
  fs.mkdirSync(dir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", "-", "-C", dir, "--strip-components=1"], { input: tgz, stdio: ["pipe", "inherit", "inherit"] });
  if (tar.status !== 0) throw new Error("tar could not unpack the archive");
}

async function stage(platform: string, dest: string): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const lock = (JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, LockEntry> }).packages;
  for (const pkg of nativePackages(lock, platform)) {
    const res = await fetch(pkg.resolved);
    if (!res.ok) throw new Error(`${pkg.resolved} answered ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const problem = integrityProblem(bytes, pkg.integrity);
    if (problem) throw new Error(`${pkg.key}@${pkg.version}: ${problem}`);
    const dir = path.join(dest, pkg.key);
    try {
      unpackInto(bytes, dir);
    } catch (err) {
      throw new Error(`${pkg.key}: ${(err as Error).message}`, { cause: err });
    }
    const version = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string }).version;
    if (version !== pkg.version) throw new Error(`${pkg.key}: unpacked ${version}, the lockfile says ${pkg.version}`);
    console.log(`    ${pkg.key.replace(/^node_modules\//, "")}@${pkg.version}`);
  }
}

if (isMain(import.meta.url, process.argv[1])) {
  const [platform, dest] = process.argv.slice(2);
  if (!platform || !dest) {
    console.error("usage: node scripts/stage-native-modules.ts <archive platform> <stage dir>");
    process.exit(2);
  }
  try {
    await stage(platform, path.resolve(dest));
  } catch (err) {
    // The ternary errorMessage() replaces, kept on purpose: plain Node runs this,
    // and main/ imports its own modules as `.js`, which it cannot resolve.
    // eslint-disable-next-line no-restricted-syntax
    console.error(`[stage-native-modules] FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
