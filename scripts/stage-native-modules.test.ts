// What a packaged install's node_modules carries for sharp, read off the real
// package-lock.json. Exact sorted lists, one per line.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { integrityProblem, nativePackages, type LockEntry } from "./stage-native-modules.ts";

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
