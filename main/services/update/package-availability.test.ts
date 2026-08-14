import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fetchTapVersion,
  homebrewInstallable,
  platformAsset,
  tapFormulaUrl,
  tarballInstallable,
} from "./package-availability.js";
import { packagedUpdateStatus, parseReleases } from "./release-check.js";

// "Released" is not "installable". GitHub publishes a release before its
// archives finish uploading, and the Homebrew tap is regenerated a few minutes
// later still. Through that window a packaged box could not install the newer
// version — so it reported "up to date", which looks exactly like a release
// build that failed and is never coming.

const rel = (tag: string, assets: string[] = []) => ({
  tag_name: tag,
  name: tag,
  draft: false,
  published_at: "2026-08-14T00:00:00Z",
  assets: assets.map((name) => ({ name })),
});

const ARCHIVES = (v: string) => [
  `stage-utility-${v}-darwin-arm64.tar.gz`,
  `stage-utility-${v}-linux-x64.tar.gz`,
  `stage-utility-${v}-win-x64.tar.gz`,
];

describe("platformAsset", () => {
  it("names the archive the release workflow actually publishes", () => {
    assert.equal(platformAsset("1.10.0", "darwin", "arm64"), "stage-utility-1.10.0-darwin-arm64.tar.gz");
    assert.equal(platformAsset("1.10.0", "linux", "x64"), "stage-utility-1.10.0-linux-x64.tar.gz");
    assert.equal(platformAsset("1.10.0", "win32", "x64"), "stage-utility-1.10.0-win-x64.tar.gz");
  });

  it("has no answer for a platform or architecture that is never published", () => {
    assert.equal(platformAsset("1.10.0", "win32", "arm64"), null, "no arm64 Windows build exists");
    assert.equal(platformAsset("1.10.0", "freebsd", "x64"), null);
    assert.equal(platformAsset("1.10.0", "linux", "arm"), null, "32-bit ARM is not published");
  });
});

describe("tarballInstallable", () => {
  it("waits for the archive this machine needs", () => {
    const [r] = parseReleases([rel("v1.10.1", ["stage-utility-1.10.1-linux-x64.tar.gz"])]);
    assert.equal(tarballInstallable(r, "linux", "x64"), true);
    assert.equal(tarballInstallable(r, "darwin", "arm64"), false, "another platform's archive is not this one's");
  });

  it("a release with no archives attached is NOT installable — that is the window", () => {
    // GitHub publishes the release, then uploads the archives. Offering it in
    // between produces an installer that 404s.
    const [r] = parseReleases([rel("v1.10.1")]);
    assert.equal(tarballInstallable(r, "darwin", "arm64"), false);
  });
});

describe("homebrewInstallable", () => {
  const [newer] = parseReleases([rel("v1.10.0-beta.32")]);

  it("blocks a release the tap has not caught up to", () => {
    assert.equal(homebrewInstallable(newer, "1.10.0-beta.31"), false);
  });

  it("allows it once the formula names it", () => {
    assert.equal(homebrewInstallable(newer, "1.10.0-beta.32"), true);
    assert.equal(homebrewInstallable(newer, "1.10.0-beta.33"), true, "a tap ahead of us is fine");
  });

  it("an unreadable tap never invents a block", () => {
    assert.equal(homebrewInstallable(newer, null), true);
    assert.equal(homebrewInstallable(newer, "not-a-version"), true);
  });
});

describe("fetchTapVersion", () => {
  it("reads the version out of the formula", async () => {
    const body = 'class StageUtilityBeta < Formula\n  desc "x"\n  version "1.10.0-beta.32"\n  license "GPL-3.0"\n';
    const v = await fetchTapVersion("stage-utility-beta", async () => ({ ok: true, text: async () => body }));
    assert.equal(v, "1.10.0-beta.32");
  });

  it("asks the tap the formula actually lives in", () => {
    assert.match(tapFormulaUrl("stage-utility-beta"), /homebrew-stage-utility\/main\/Formula\/stage-utility-beta\.rb$/);
  });

  it("returns null — never a wrong version — when the tap cannot be read", async () => {
    assert.equal(await fetchTapVersion("x", async () => ({ ok: false, text: async () => "" })), null);
    assert.equal(await fetchTapVersion("x", async () => { throw new Error("offline"); }), null);
    assert.equal(await fetchTapVersion("x", async () => ({ ok: true, text: async () => "no version here" })), null);
  });
});

describe("packagedUpdateStatus with a package still building", () => {
  const releases = parseReleases([
    rel("v1.10.0-beta.32"), // released; archives not up yet
    rel("v1.10.0-beta.31", ARCHIVES("1.10.0-beta.31")),
    rel("v1.10.0-beta.30", ARCHIVES("1.10.0-beta.30")),
  ]);

  it("offers the newest INSTALLABLE release and names the one still building", () => {
    const s = packagedUpdateStatus(releases, "beta", "1.10.0-beta.30", (r) =>
      tarballInstallable(r, "darwin", "arm64"),
    );
    assert.equal(s.targetTag, "v1.10.0-beta.31", "must not offer an update that would 404");
    assert.equal(s.releasesBehind, 1, "only the installable one counts as behind");
    assert.equal(s.awaitingPackage, "v1.10.0-beta.32");
  });

  it("a box already on the newest installable is NOT simply 'up to date'", () => {
    // The window this exists for: nothing to install, but something is coming.
    const s = packagedUpdateStatus(releases, "beta", "1.10.0-beta.31", (r) =>
      tarballInstallable(r, "darwin", "arm64"),
    );
    assert.equal(s.releasesBehind, 0);
    assert.equal(s.awaitingPackage, "v1.10.0-beta.32", "the wait must be visible, not silent");
  });

  it("says nothing is pending once every release is installable", () => {
    const all = parseReleases([
      rel("v1.10.0-beta.32", ARCHIVES("1.10.0-beta.32")),
      rel("v1.10.0-beta.31", ARCHIVES("1.10.0-beta.31")),
    ]);
    const s = packagedUpdateStatus(all, "beta", "1.10.0-beta.32", (r) => tarballInstallable(r, "darwin", "arm64"));
    assert.equal(s.awaitingPackage, null);
    assert.equal(s.releasesBehind, 0);
  });

  it("defaults to installable, so a caller that cannot tell reports as before", () => {
    const s = packagedUpdateStatus(releases, "beta", "1.10.0-beta.30");
    assert.equal(s.targetTag, "v1.10.0-beta.32");
    assert.equal(s.awaitingPackage, null);
  });
});
