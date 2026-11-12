// What a packaged install's node_modules carries for sharp, read off the real
// package-lock.json. Exact sorted lists, one per line.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, test } from "node:test";

import { integrityProblem, nativePackages, unpackInto, unsafeEntries, type LockEntry } from "./stage-native-modules.ts";

const lock = (JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, LockEntry> }).packages;
const keys = (platform: string) => nativePackages(lock, platform).map((p) => p.key);

const COMMON = ["node_modules/@img/colour", "node_modules/detect-libc", "node_modules/semver", "node_modules/sharp"];

describe("nativePackages", () => {
  test("linux-x64: sharp, its JavaScript dependencies, and the glibc x64 build", () => {
    assert.deepEqual(keys("linux-x64"), [
      "node_modules/@img/colour",
      "node_modules/@img/sharp-libvips-linux-x64",
      "node_modules/@img/sharp-linux-x64",
      "node_modules/detect-libc",
      "node_modules/semver",
      "node_modules/sharp",
    ]);
  });

  test("each other platform takes its own build and nothing else's", () => {
    const native = (p: string) => keys(p).filter((k) => !COMMON.includes(k));
    assert.deepEqual(native("linux-arm64"), ["node_modules/@img/sharp-libvips-linux-arm64", "node_modules/@img/sharp-linux-arm64"]);
    assert.deepEqual(native("darwin-arm64"), ["node_modules/@img/sharp-darwin-arm64", "node_modules/@img/sharp-libvips-darwin-arm64"]);
    assert.deepEqual(native("darwin-x64"), ["node_modules/@img/sharp-darwin-x64", "node_modules/@img/sharp-libvips-darwin-x64"]);
    // Windows bundles libvips inside its package.
    assert.deepEqual(native("win-x64"), ["node_modules/@img/sharp-win32-x64"]);
  });

  test("every package is pinned to the lockfile's version, URL and hash", () => {
    for (const p of nativePackages(lock, "linux-arm64")) {
      assert.equal(p.version, lock[p.key]!.version);
      assert.equal(p.resolved, lock[p.key]!.resolved);
      assert.equal(p.integrity, lock[p.key]!.integrity);
    }
  });

  test("a lockfile missing the platform's build is refused, naming it", () => {
    const broken = { ...lock };
    delete broken["node_modules/@img/sharp-linux-arm64"];
    assert.throws(() => nativePackages(broken, "linux-arm64"), /@img\/sharp-linux-arm64/);
    assert.throws(() => nativePackages(lock, "freebsd-x64"), /unknown platform/);
  });
});

describe("integrityProblem", () => {
  test("accepts the bytes the hash names and refuses any others", () => {
    const bytes = Buffer.from("a tarball");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    assert.equal(integrityProblem(bytes, integrity), null);
    assert.match(integrityProblem(Buffer.from("another tarball"), integrity) ?? "", /integrity mismatch/);
    assert.match(integrityProblem(bytes, "sha1-abc") ?? "", /unsupported/);
  });
});

describe("unpacking a tarball from memory", () => {
  /** A one-file ustar archive, gzipped, whose entry is named exactly `name`. */
  function tgzWith(name: string, body: string): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\u000000", 257, 8, "binary");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
    data.write(body, 0, "utf8");
    return gzipSync(Buffer.concat([header, data, Buffer.alloc(1024)]));
  }

  test("unsafeEntries names absolute paths and .. segments, and nothing else", () => {
    assert.deepEqual(unsafeEntries(["package/a.js", "package/lib/b.js", "package/..x/c", "/etc/passwd", "package/../../evil", "C:/x", "a\\..\\b"]), [
      "/etc/passwd",
      "package/../../evil",
      "C:/x",
      "a\\..\\b",
    ]);
  });

  test("a good tarball unpacks into its folder, package/ dropped", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "unpack-good-"));
    try {
      unpackInto(tgzWith("package/index.js", "module.exports = 1;\n"), path.join(dir, "pkg"));
      assert.equal(readFileSync(path.join(dir, "pkg", "index.js"), "utf8"), "module.exports = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tarball with an entry outside its folder is refused, and nothing is written", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "unpack-evil-"));
    try {
      const target = path.join(dir, "a", "b", "pkg");
      assert.throws(() => unpackInto(tgzWith("package/../../evil.txt", "owned\n"), target), /outside its folder/);
      assert.equal(existsSync(path.join(dir, "a", "evil.txt")), false, "the entry escaped");
      assert.equal(existsSync(target), false, "something was unpacked before the refusal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
