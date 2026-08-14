// package-availability.ts — "released" is not the same as "installable".
//
// A git checkout already distinguishes these: work can be merged but not yet
// released, and the UI says so rather than claiming the box is up to date. A
// packaged install has the same gap one step further along — the release exists
// on GitHub, but the thing that installs it does not exist yet:
//
//   tarball   the release is published before its per-platform archives finish
//             uploading; the installer would 404 on the one it needs.
//   homebrew  the release is published before the tap formula is regenerated,
//             so `brew upgrade` is a no-op that restarts nothing.
//
// Without this the box says "up to date" through that window (it cannot install
// the newer thing, so nothing is behind), which is indistinguishable from a
// release build that FAILED and is never coming. Naming the gap turns a silent
// wait into a visible one.

import type { ReleaseInfo } from "./release-check.js";
import { compareTags, parseTag } from "../release-tags.js";

/** The archive name build-artifacts.sh publishes for a platform. */
export function platformAsset(version: string, platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "win" : null;
  if (!os) return null;
  // Only the two architectures the release workflow builds; win ships x64 only.
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) return null;
  if (os === "win" && cpu !== "x64") return null;
  return `stage-utility-${version}-${os}-${cpu}.tar.gz`;
}

/** Can a one-line-installer box install this release right now? */
export function tarballInstallable(
  release: ReleaseInfo,
  platform: NodeJS.Platform,
  arch: string,
): boolean {
  const version = release.tag.replace(/^v/, "");
  const want = platformAsset(version, platform, arch);
  if (!want) return false;
  // Exact membership, including the empty case: a release with no archives
  // attached is precisely the window this exists for — published, not yet
  // uploaded — and "install it anyway" is a 404. The API always sends an
  // assets array, so empty means empty rather than unknown.
  return release.assets.includes(want);
}

/**
 * Can a Homebrew box install this release right now?
 *
 * The tap carries ONE version per formula, so anything newer than the formula
 * is not installable — that is the whole tap-lag window.
 */
export function homebrewInstallable(release: ReleaseInfo, formulaVersion: string | null): boolean {
  if (!formulaVersion) return true; // could not read the tap — do not invent a block
  const formula = parseTag(`v${formulaVersion.replace(/^v/, "")}`);
  const rel = parseTag(release.tag);
  if (!formula || !rel) return true;
  // The same comparator the rest of the updater orders releases with, so the
  // tap-lag window can never disagree with what "newer" means elsewhere.
  return compareTags(rel, formula) <= 0;
}

const TAP_REPO = "Cornerstone-Production/homebrew-stage-utility";

/** Where the tap keeps each track's formula. */
export function tapFormulaUrl(formula: string): string {
  return `https://raw.githubusercontent.com/${TAP_REPO}/main/Formula/${formula}.rb`;
}

/**
 * The version the tap would install right now, or null when it cannot be read.
 *
 * Read from the tap over HTTP rather than from the local clone: the clone is
 * only refreshed by `brew update`, so a stale one would report a lag that is
 * not real (or miss one that is). Null on any failure — an unreadable tap must
 * never manufacture a "still building" warning.
 */
export async function fetchTapVersion(
  formula: string,
  doFetch: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>,
): Promise<string | null> {
  try {
    const res = await doFetch(tapFormulaUrl(formula));
    if (!res.ok) return null;
    return /^\s*version\s+"([^"]+)"/m.exec(await res.text())?.[1] ?? null;
  } catch {
    return null;
  }
}
