#!/usr/bin/env node
// manifest-changed.mjs — did an update actually change dependencies or build inputs?
//
// The update scripts skip `npm ci` and `npm run build` when nothing relevant
// changed, which on a Pi is the difference between a ~3s restart and a couple of
// minutes with the displays dark.
//
// Deciding that by filename does not work. Every release carries the workflow's
// own version bump:
//
//   chore(release): v1.9.2-beta.2 [skip ci]
//     package.json      | 2 +-
//     package-lock.json | 4 ++--
//
// which is nothing but three version strings — yet it touches both manifests, so
// a path-matching rule fires on every single update and the skip never happens.
//
// So compare the parsed content with the root version removed. The version is
// read from package.json at runtime rather than compiled into the bundle, so a
// version-only change genuinely needs neither step.
//
// Usage:  node scripts/manifest-changed.mjs <oldRev> <newRev>
// Output: {"deps":bool,"manifest":bool}   (deps => reinstall, either => rebuild)
//
// Fails safe: anything unreadable or unparseable reports true, so an unknown
// state does the work rather than skipping it.

import { execFileSync } from "node:child_process";

/** A file at a revision, or null when it isn't there / can't be read. */
function fileAt(rev, file) {
  try {
    return execFileSync("git", ["show", `${rev}:${file}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Parse, or null when the text isn't JSON. */
function parse(text) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The lockfile's dependency graph — everything except this package's version. */
function lockShape(lock) {
  if (!lock || typeof lock !== "object") return null;
  const copy = structuredClone(lock);
  delete copy.version;
  // npm writes the root package's version here too (lockfileVersion 2+).
  if (copy.packages && typeof copy.packages === "object" && copy.packages[""]) {
    delete copy.packages[""].version;
  }
  return JSON.stringify(copy);
}

/** package.json without its version — scripts, deps, build config. */
function manifestShape(pkg) {
  if (!pkg || typeof pkg !== "object") return null;
  const copy = structuredClone(pkg);
  delete copy.version;
  return JSON.stringify(copy);
}

export function compareRevs(oldRev, newRev, read = fileAt) {
  // No old revision to compare against — do everything.
  if (!oldRev || !newRev || oldRev === "none" || newRev === "none") {
    return { deps: true, manifest: true };
  }
  if (oldRev === newRev) return { deps: false, manifest: false };

  const oldLock = lockShape(parse(read(oldRev, "package-lock.json")));
  const newLock = lockShape(parse(read(newRev, "package-lock.json")));
  const oldPkg = manifestShape(parse(read(oldRev, "package.json")));
  const newPkg = manifestShape(parse(read(newRev, "package.json")));

  // Unreadable or unparseable at either end: assume the worst and do the work.
  const deps = oldLock === null || newLock === null ? true : oldLock !== newLock;
  const manifest = oldPkg === null || newPkg === null ? true : oldPkg !== newPkg;
  return { deps, manifest };
}

// Only run when invoked directly, so the test can import the function.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const [, , oldRev, newRev] = process.argv;
  try {
    process.stdout.write(JSON.stringify(compareRevs(oldRev, newRev)));
  } catch {
    process.stdout.write(JSON.stringify({ deps: true, manifest: true }));
  }
}
