// github-repo.ts — where this project's releases live, spelled once.
//
// The updater, the installer fetch and the Mac output helper's download all talk
// to the same repository's releases; each used to spell the name and the hosts
// itself. The shell installers cannot import this; install.sh, install.ps1 and
// scripts/kiosk/install-macos.sh keep their own spellings, each with a comment
// pointing here.

const REPO = "Cornerstone-Production/Stage-Utility";

/** The releases API root for this repository: `<api>/releases/...`. */
export const GITHUB_API_REPO = `https://api.github.com/repos/${REPO}`;

/** Where a release's assets download from: `<download>/v<version>/<name>`. */
export const GITHUB_RELEASE_DOWNLOAD = `https://github.com/${REPO}/releases/download`;

/** A file on a branch, raw. */
export const GITHUB_RAW = `https://raw.githubusercontent.com/${REPO}`;

/**
 * A 403 that is really a quota, told as one.
 *
 * GitHub sends x-ratelimit-remaining: 0 with a reset epoch. Saying "try again at
 * 10:47" is the difference between a message an operator can act on and one that
 * looks like the updater is broken. Null when the response is not a quota.
 */
export function rateLimitMessage(res: { headers?: { get(name: string): string | null } }): string | null {
  const remaining = res.headers?.get("x-ratelimit-remaining");
  if (remaining !== "0") return null;
  const reset = Number(res.headers?.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset)) return "GitHub's hourly limit for this network is used up.";
  const at = new Date(reset * 1000);
  const mins = Math.max(1, Math.round((at.getTime() - Date.now()) / 60_000));
  return `GitHub's hourly limit for this network is used up — it resets in ${mins} min.`;
}
