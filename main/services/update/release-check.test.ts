import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packagedUpdateStatus, parseReleases } from "./release-check.js";

// Shaped like the GitHub releases API: newest first, one object per release.
const gh = (tag: string, opts: { prerelease?: boolean; draft?: boolean; name?: string } = {}) => ({
  tag_name: tag,
  name: opts.name ?? tag,
  prerelease: opts.prerelease ?? tag.includes("-"),
  draft: opts.draft ?? false,
  published_at: `2026-08-0${tag.length % 9}T00:00:00Z`,
});

const RELEASES = parseReleases([
  gh("v1.10.0-beta.27"),
  gh("v1.10.0-beta.26"),
  gh("v1.10.0-beta.25"),
  gh("v1.9.5"),
  gh("v1.9.4"),
]);

describe("parseReleases", () => {
  it("keeps tag, name and date; drops drafts and junk", () => {
    const parsed = parseReleases([
      gh("v1.9.5"),
      gh("v1.9.4", { draft: true }),
      { nonsense: true },
      "not even an object",
      null,
    ]);
    assert.deepEqual(
      parsed.map((r) => r.tag),
      ["v1.9.5"],
    );
    assert.equal(parsed[0].publishedAt, gh("v1.9.5").published_at);
  });

  it("returns [] for a response that is not an array", () => {
    assert.deepEqual(parseReleases({ message: "API rate limit exceeded" }), []);
    assert.deepEqual(parseReleases(undefined), []);
  });
});

describe("packagedUpdateStatus", () => {
  it("reports how many releases a beta box is behind, and which tag an update lands on", () => {
    const s = packagedUpdateStatus(RELEASES, "beta", "1.10.0-beta.25");
    assert.equal(s.targetTag, "v1.10.0-beta.27");
    assert.equal(s.currentTag, "v1.10.0-beta.25");
    assert.equal(s.releasesBehind, 2);
    assert.equal(s.tagBased, true);
    // What the auto-apply schedule and older UI gates read.
    assert.ok(s.behind > 0);
    assert.ok(s.behindUserFacing > 0);
  });

  it("a main box never sees a prerelease", () => {
    const s = packagedUpdateStatus(RELEASES, "main", "1.9.4");
    assert.equal(s.targetTag, "v1.9.5");
    assert.equal(s.releasesBehind, 1);
    assert.ok(!s.changelog.join(" ").includes("beta"));
  });

  it("up to date means zero, not one", () => {
    const s = packagedUpdateStatus(RELEASES, "beta", "1.10.0-beta.27");
    assert.equal(s.releasesBehind, 0);
    assert.equal(s.behind, 0);
    assert.equal(s.targetTag, "v1.10.0-beta.27");
  });

  it("a stable release outranks the betas that led to it, so a beta box is offered it", () => {
    const releases = parseReleases([gh("v1.10.0", { prerelease: false }), gh("v1.10.0-beta.27")]);
    const s = packagedUpdateStatus(releases, "beta", "1.10.0-beta.27");
    assert.equal(s.targetTag, "v1.10.0");
    assert.equal(s.releasesBehind, 1);
  });

  it("an unreadable current version still offers the newest release rather than claiming current", () => {
    const s = packagedUpdateStatus(RELEASES, "beta", "0.0.0");
    assert.equal(s.targetTag, "v1.10.0-beta.27");
    assert.ok(s.releasesBehind > 0, "must not read as up to date");
    assert.equal(s.currentTag, null);
  });

  it("no releases at all → nothing offered, nothing behind", () => {
    const s = packagedUpdateStatus([], "main", "1.9.5");
    assert.equal(s.targetTag, null);
    assert.equal(s.releasesBehind, 0);
  });

  it("changelog lists the newer releases, newest first, capped", () => {
    const many = parseReleases(
      Array.from({ length: 30 }, (_, i) => gh(`v1.10.${29 - i}`, { prerelease: false })),
    );
    const s = packagedUpdateStatus(many, "main", "1.10.0");
    assert.equal(s.changelog.length, 20);
    assert.ok(s.changelog[0].includes("v1.10.29"));
  });
});
