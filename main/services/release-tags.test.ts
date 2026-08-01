import { strict as assert } from "node:assert";
import { test } from "node:test";

import { compareTags, latestOnTrack, newerThan, parseTag } from "./release-tags.js";

const p = (t: string) => {
  const v = parseTag(t);
  assert.ok(v, `${t} should parse`);
  return v;
};
const cmp = (a: string, b: string) => compareTags(p(a), p(b));

// ── Parsing ────────────────────────────────────────────────────────────────

test("a stable tag parses with no prerelease identifiers", () => {
  assert.deepEqual(p("v1.9.2"), { tag: "v1.9.2", major: 1, minor: 9, patch: 2, pre: [] });
});

test("a prerelease splits into identifiers, numbers staying numbers", () => {
  assert.deepEqual(p("v1.10.0-beta.3").pre, ["beta", 3]);
});

test("things that are not release tags are rejected rather than half-parsed", () => {
  for (const bad of ["1.9.2", "v1.9", "vX.Y.Z", "release-1.9.2", "v1.9.2.3", ""]) {
    assert.equal(parseTag(bad), null, `${bad} should not parse`);
  }
  assert.ok(parseTag("  v1.9.2  "), "surrounding whitespace is tolerated");
});

// ── Ordering ───────────────────────────────────────────────────────────────

test("numeric fields compare in order of significance", () => {
  assert.ok(cmp("v2.0.0", "v1.99.99") > 0);
  assert.ok(cmp("v1.10.0", "v1.9.9") > 0, "10 is newer than 9 — not a string compare");
  assert.ok(cmp("v1.9.3", "v1.9.2") > 0);
  assert.equal(cmp("v1.9.2", "v1.9.2"), 0);
});

test("a release outranks its own prerelease", () => {
  // This is the case git's own version sort gets backwards, and the reason
  // ordering does not come from `git tag --sort=-v:refname`.
  assert.ok(cmp("v1.10.0", "v1.10.0-beta.1") > 0);
  assert.ok(cmp("v1.10.0-beta.1", "v1.10.0") < 0);
});

test("prerelease counters compare numerically, not as text", () => {
  assert.ok(cmp("v1.9.2-beta.10", "v1.9.2-beta.2") > 0, "beta.10 is newer than beta.2");
  assert.ok(cmp("v1.9.2-beta.2", "v1.9.2-beta.10") < 0);
});

test("a shorter identifier list ranks lower", () => {
  assert.ok(cmp("v1.0.0-beta.1", "v1.0.0-beta") > 0);
});

test("alphanumeric identifiers outrank numeric ones, per semver", () => {
  assert.ok(cmp("v1.0.0-beta", "v1.0.0-1") > 0);
  assert.ok(cmp("v1.0.0-alpha", "v1.0.0-beta") < 0);
});

test("sorting a realistic tag list puts the true newest last", () => {
  const tags = ["v1.9.2-beta.2", "v1.10.0", "v1.9.2", "v1.10.0-beta.1", "v1.9.2-beta.10"];
  const sorted = tags.map(p).sort(compareTags).map((t) => t.tag);
  assert.deepEqual(sorted, ["v1.9.2-beta.2", "v1.9.2-beta.10", "v1.9.2", "v1.10.0-beta.1", "v1.10.0"]);
});

// ── Track selection ────────────────────────────────────────────────────────

const TAGS = ["v1.0.0", "v1.9.2-beta.1", "v1.9.2-beta.2", "v1.9.2", "v1.10.0-beta.1"];

test("main takes only stable releases", () => {
  assert.equal(latestOnTrack(TAGS, "main")?.tag, "v1.9.2");
});

test("beta takes prereleases", () => {
  assert.equal(latestOnTrack(TAGS, "beta")?.tag, "v1.10.0-beta.1");
});

test("a beta box is not held back from a newer stable release", () => {
  // v1.9.2 is strictly newer than the betas that produced it. If beta filtered
  // stable tags out, a box would sit on v1.9.2-beta.2 forever.
  assert.equal(latestOnTrack(["v1.9.2-beta.1", "v1.9.2-beta.2", "v1.9.2"], "beta")?.tag, "v1.9.2");
});

test("a track with no eligible tags returns null rather than guessing", () => {
  assert.equal(latestOnTrack(["v1.0.0-beta.1"], "main"), null);
  assert.equal(latestOnTrack([], "beta"), null);
});

test("junk refs in the tag list are ignored, not crashed on", () => {
  assert.equal(latestOnTrack(["not-a-tag", "v1.2.3", "nightly"], "main")?.tag, "v1.2.3");
});

// ── What counts as an available update ─────────────────────────────────────

test("only tags newer than the current one count, newest first", () => {
  assert.deepEqual(
    newerThan(TAGS, "beta", "v1.9.2-beta.1").map((t) => t.tag),
    ["v1.10.0-beta.1", "v1.9.2", "v1.9.2-beta.2"],
  );
});

test("being on the newest tag means nothing is available", () => {
  assert.deepEqual(newerThan(TAGS, "beta", "v1.10.0-beta.1"), []);
  assert.deepEqual(newerThan(TAGS, "main", "v1.9.2"), []);
});

test("a box ahead of every tag is not offered a downgrade", () => {
  assert.deepEqual(newerThan(TAGS, "beta", "v2.0.0"), []);
});

test("an untagged checkout is offered the whole track", () => {
  assert.equal(newerThan(TAGS, "main", null).length, 2); // v1.0.0 and v1.9.2
});

test("main ignores prereleases when counting what's available", () => {
  assert.deepEqual(newerThan(TAGS, "main", "v1.0.0").map((t) => t.tag), ["v1.9.2"]);
});
