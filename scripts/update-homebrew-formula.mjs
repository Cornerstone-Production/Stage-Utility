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
//   node scripts/update-homebrew-formula.mjs <version> --sums path/to/SHA256SUMS
//
// The checksum file is always a local path, never fetched here. The release
// workflow already has it — it built it — and a script that writes a file people
// install from should not also be the thing deciding what to trust off the
// network. To run this by hand, download it first:
//
//   gh release download v<version> --pattern SHA256SUMS

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMULA = path.join(ROOT, "packaging", "homebrew", "stage-utility.rb");

const version = process.argv[2];
const sumsArg = process.argv.indexOf("--sums");
if (!version || sumsArg === -1 || !process.argv[sumsArg + 1]) {
  console.error("usage: update-homebrew-formula.mjs <version> --sums <SHA256SUMS>");
  console.error("  get the file with: gh release download v<version> --pattern SHA256SUMS");
  process.exit(1);
}

/** The platforms Homebrew can install. Windows is not one of them. */
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

const sums = fs.readFileSync(process.argv[sumsArg + 1], "utf8");

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

// A prerelease updates the beta formula, a full release the stable one. Two
// formulae exist because a Homebrew install switches tracks by swapping which
// one is installed — brew has no notion of a channel within a single formula.
//
// The beta formula is DERIVED from the stable one rather than kept as a second
// file: two hand-maintained formulae drift, and the drift would only show up
// when someone on the beta track tried to update. The only differences are the
// class name and the conflict declaration.
const isPrerelease = version.includes("-");
const BETA_FORMULA = path.join(ROOT, "packaging", "homebrew", "stage-utility-beta.rb");
const target = isPrerelease ? BETA_FORMULA : FORMULA;

let src = fs.readFileSync(FORMULA, "utf8");
if (isPrerelease) {
  src = src
    .replace(/^class StageUtility\b/m, "class StageUtilityBeta")
    .replace(/^(class StageUtilityBeta.*\n)/m, "$1  # Generated from stage-utility.rb - do not edit by hand.\n");
  // Both formulae install a binary called stage-utility, so brew must be told
  // they cannot coexist. The updater uninstalls one before installing the other;
  // this is what makes a direct `brew install` fail loudly rather than clobber.
  if (!/conflicts_with/.test(src)) {
    // Anchored on the top-level `version` line, NOT on the first `url` - the
    // first url sits inside a per-platform block, and conflicts_with is only
    // valid at formula scope.
    const anchor = /^(\s*version\s+"[^"]+"\n)/m;
    if (!anchor.test(src)) {
      console.error("[homebrew] could not find the version line to anchor conflicts_with");
      process.exit(1);
    }
    src = src.replace(
      anchor,
      '$1  conflicts_with "stage-utility", because: "both install a stage-utility binary"\n',
    );
  }
}
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

const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
if (existing === src) {
  console.log(`[homebrew] ${path.basename(target)} already at ${version}`);
} else {
  fs.writeFileSync(target, src);
  const what = isPrerelease ? "beta formula" : "formula";
  console.log(`[homebrew] ${what} updated to ${version} (${PLATFORMS.length} platforms)`);
}
