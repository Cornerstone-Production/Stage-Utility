// The lockfile carries sharp's native build for every platform an install runs on.
//
// sharp ships its libvips binaries as optional packages, one per platform, and
// `npm ci` installs only what package-lock.json lists. Regenerating the
// lockfile with one platform's package already in node_modules can drop the
// others (npm/cli#4828), and the result installs fine on the machine that made
// it: the first sign would be every Raspberry Pi's update failing to load
// sharp. So the entries for the five deploy targets are pinned here, exactly.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** The deploy targets: linux-x64, linux-arm64 (a Pi), darwin-arm64, darwin-x64
 *  and win32-x64. Windows bundles libvips inside its sharp package. Sorted, one
 *  per line. */
const EXPECTED = [
  "@img/sharp-darwin-arm64",
  "@img/sharp-darwin-x64",
  "@img/sharp-libvips-darwin-arm64",
  "@img/sharp-libvips-darwin-x64",
  "@img/sharp-libvips-linux-arm64",
  "@img/sharp-libvips-linux-x64",
  "@img/sharp-linux-arm64",
  "@img/sharp-linux-x64",
  "@img/sharp-win32-x64",
];

/** The deploy targets' packages (linux ones are glibc builds). musl, 32-bit,
 *  Windows on arm, wasm and the rest may be in the lockfile and are not required. */
const DEPLOYED = /^node_modules\/(@img\/sharp-(?:libvips-)?(?:darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-x64))$/;

type LockEntry = { resolved?: string; integrity?: string; optional?: boolean };

const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, LockEntry>;
};

const deployed = Object.entries(lock.packages)
  .map(([key, entry]) => [DEPLOYED.exec(key)?.[1], entry] as const)
  .filter((pair): pair is readonly [string, LockEntry] => pair[0] !== undefined);

test("package-lock.json lists sharp's build for every deploy target", () => {
  assert.deepEqual(deployed.map(([name]) => name).sort(), EXPECTED);
});

test("each of those entries can be fetched by npm ci", () => {
  for (const [name, entry] of deployed) {
    assert.ok(entry.resolved?.startsWith("https://registry.npmjs.org/"), `${name} has no registry URL`);
    assert.ok(entry.integrity?.startsWith("sha512-"), `${name} has no integrity hash`);
    assert.equal(entry.optional, true, `${name} must stay optional, or every other platform fails to install it`);
  }
});
