#!/usr/bin/env node
// update-homebrew-formula.mjs — rewrite the formula for a given release.
//
// A Homebrew formula pins a version and a checksum per platform, so it is stale
// the moment a release is cut. Rewriting it by hand is the kind of step that gets
// skipped, and a formula with a stale checksum fails to install with an error
// that reads like a corrupted download.
//
// Reads the checksums the release already publishes rather than re-hashing
// anything, so the formula can only ever agree with what was actually shipped.
//
//   node scripts/update-homebrew-formula.mjs <version> [--sums path/to/SHA256SUMS]
//
// With no --sums it downloads SHA256SUMS from the release.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMULA = path.join(ROOT, "packaging", "homebrew", "stage-utility.rb");
const REPO = process.env.STAGE_REPO ?? "Cornerstone-Production/Stage-Utility";

const version = process.argv[2];
if (!version) {
  console.error("usage: update-homebrew-formula.mjs <version> [--sums <file>]");
  process.exit(1);
}
const sumsArg = process.argv.indexOf("--sums");

/** The platforms Homebrew can install. Windows is not one of them. */
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

async function readSums() {
  if (sumsArg > -1) return fs.readFileSync(process.argv[sumsArg + 1], "utf8");
  const url = `https://github.com/${REPO}/releases/download/v${version}/SHA256SUMS`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status}`);
  return res.text();
}

const sums = await readSums();

/** platform -> sha256, from the release's own checksum file. */
const bySha = new Map();
for (const line of sums.split("\n")) {
  const m = /^([0-9a-f]{64})\s+stage-utility-(.+)-([a-z0-9]+-[a-z0-9]+)\.tar\.gz$/.exec(line.trim());
  if (m && m[2] === version) bySha.set(m[3], m[1]);
}

const missing = PLATFORMS.filter((p) => !bySha.has(p));
if (missing.length) {
  // Better to fail than to publish a formula that half-installs.
  console.error(`[homebrew] no checksum for ${missing.join(", ")} in the release — not updating`);
  process.exit(1);
}

let src = fs.readFileSync(FORMULA, "utf8");
const before = src;

src = src.replace(/^(\s*version\s+)"[^"]+"/m, `$1"${version}"`);

// Each sha256 sits directly under the url naming its platform, so anchor on that
// rather than on ordering — a reordered formula must not silently mis-assign a
// checksum to the wrong architecture.
// Only the platforms the formula actually has a block for. The release also
// publishes win-x64, which Homebrew does not install.
for (const platform of PLATFORMS) {
  const sha = bySha.get(platform);

  // Re-assert the shape here, at the point of use. The parse regex above already
  // constrains this to 64 hex characters, but that is thirty lines away, and
  // this value comes off the network and ends up in a file people install from.
  // A later edit that loosens the parser must not be able to widen what gets
  // written, and the guarantee should be readable where it matters.
  if (!/^[0-9a-f]{64}$/.test(sha ?? "")) {
    console.error(`[homebrew] checksum for ${platform} is not a sha256 digest — not updating`);
    process.exit(1);
  }

  const re = new RegExp(
    `(url "[^"]*stage-utility-#\\{version\\}-${platform}\\.tar\\.gz"\\s*\\n\\s*sha256 ")[0-9a-f]{64}(")`,
  );
  if (!re.test(src)) {
    console.error(`[homebrew] could not find the ${platform} block in the formula`);
    process.exit(1);
  }
  // A replacer function, not a template string: in a replacement string `$&`,
  // `$1` and friends are substitution patterns. A digest cannot contain them,
  // but relying on that is relying on the check above never being relaxed.
  src = src.replace(re, (_full, before, after) => `${before}${sha}${after}`);
}

if (src === before) {
  console.log(`[homebrew] already at ${version}`);
} else {
  fs.writeFileSync(FORMULA, src);
  console.log(`[homebrew] formula updated to ${version} (${PLATFORMS.length} platforms)`);
}
