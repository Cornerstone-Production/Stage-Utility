// main/services/video/mediamtx-pin.ts — the one MediaMTX version this app
// runs, and the SHA-256 of each platform's release asset.
//
// A newer MediaMTX ships as an ordinary Stage Utility release that bumps this
// file; the app never follows MediaMTX's own releases on its own.

export const MEDIAMTX_VERSION = "v1.21.1";

const MEDIAMTX_BASE = `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/`;

/** What the page says before the first download: ~27 MB fetched, ~55 MB once
 *  the archive is extracted alongside it. */
export const MEDIAMTX_DOWNLOAD_BYTES = 27_000_000;
export const MEDIAMTX_DISK_BYTES = 55_000_000;

export interface MediaMtxAsset {
  name: string;
  sha256: string;
  exe: "mediamtx" | "mediamtx.exe";
}

/** Keyed "<platform>-<arch>" — exactly the five release assets MediaMTX ships
 *  for this version (linux/darwin amd64+arm64, windows amd64). Any other
 *  platform/arch pair has no entry; see assetFor(). */
export const ASSETS: ReadonlyMap<string, MediaMtxAsset> = new Map([
  ["darwin-x64", { name: "mediamtx_v1.21.1_darwin_amd64.tar.gz", sha256: "be403a36d2225668ea695cbd2c784109bc23ef9a32f886837e43c920b6818813", exe: "mediamtx" }],
  ["darwin-arm64", { name: "mediamtx_v1.21.1_darwin_arm64.tar.gz", sha256: "25e20ed41611f1f3103b8359585210b29b11b69fa0d9e11bd11b92f7bbcb42ef", exe: "mediamtx" }],
  ["linux-x64", { name: "mediamtx_v1.21.1_linux_amd64.tar.gz", sha256: "653abc672a3e693f8d3b2717752492fdcfb8072291ec108d03d3dd857411b0ee", exe: "mediamtx" }],
  ["linux-arm64", { name: "mediamtx_v1.21.1_linux_arm64.tar.gz", sha256: "6a3aa635fb60ea9b8d566ec306f0a42ff1b6b52a3942bc2baffbe55880d4c3dd", exe: "mediamtx" }],
  ["win32-x64", { name: "mediamtx_v1.21.1_windows_amd64.zip", sha256: "faa97974861eb75a68b5aa326c78e7e7a6f670b5ef191bace78e715130381f23", exe: "mediamtx.exe" }],
]);

/** The pinned asset for this platform/arch, or null when MediaMTX ships no
 *  release for it (e.g. Windows on arm64, or anything 32-bit). */
export function assetFor(platform: NodeJS.Platform, arch: string): MediaMtxAsset | null {
  return ASSETS.get(`${platform}-${arch}`) ?? null;
}

export function downloadUrlFor(asset: MediaMtxAsset): string {
  return `${MEDIAMTX_BASE}${asset.name}`;
}
