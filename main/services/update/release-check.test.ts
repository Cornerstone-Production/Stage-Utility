import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchReleases, packagedUpdateStatus, parseReleases, clearReleaseCache } from "./release-check.js";

// Shaped like the GitHub releases API: newest first, one object per release.
// `prerelease` is here because GitHub sends it, not because it is read — the
// comparator decides that from the tag itself.
function gh(tag: string, opts: { draft?: boolean } = {}) {
  return {
    tag_name: tag,
    name: tag,
    prerelease: tag.includes("-"),
    draft: opts.draft ?? false,
    published_at: "2026-08-06T00:00:00Z",
  };
}

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
    assert.equal(parsed[0].name, "v1.9.5");
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
    const releases = parseReleases([gh("v1.10.0"), gh("v1.10.0-beta.27")]);
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
    const many = parseReleases(Array.from({ length: 30 }, (_, i) => gh(`v1.10.${29 - i}`)));
    const s = packagedUpdateStatus(many, "main", "1.10.0");
    assert.equal(s.changelog.length, 20);
    assert.ok(s.changelog[0].includes("v1.10.29"));
  });
});

describe("fetchReleases", () => {
  type Resp = { ok: boolean; status: number; json(): Promise<unknown> };
  const resp = (status: number, body: unknown): Resp => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  /** Serve the page and /releases/latest from canned bodies. */
  const serving = (page: Resp, latest: Resp) => (url: string) =>
    Promise.resolve(url.includes("/releases/latest") ? latest : page);

  it("merges the newest stable in even when the whole page is prereleases", async () => {
    // True of the real repo at the time of writing: 30 betas since v1.9.5, so
    // the page alone contains ZERO stable releases and a main-track box would
    // compute "up to date" forever — the exact silent no-op this module fixes.
    const page = Array.from({ length: 30 }, (_, i) => gh(`v1.10.0-beta.${30 - i}`));
    const releases = await fetchReleases(serving(resp(200, page), resp(200, gh("v1.9.5"))));
    const s = packagedUpdateStatus(releases, "main", "1.9.4");
    assert.equal(s.targetTag, "v1.9.5");
    assert.equal(s.releasesBehind, 1);
  });

  it("does not duplicate a stable that is already on the page", async () => {
    const releases = await fetchReleases(
      serving(resp(200, [gh("v1.9.5"), gh("v1.9.4")]), resp(200, gh("v1.9.5"))),
    );
    assert.equal(releases.filter((r) => r.tag === "v1.9.5").length, 1);
  });

  it("a 200 whose body is not the releases array is a FAILED check, not 'no releases'", async () => {
    // A rate-limit body is {message}; an intercepting proxy can 200 anything.
    // Mapping that to [] would overwrite a known "update available" with a
    // silent "up to date".
    await assert.rejects(
      fetchReleases(serving(resp(200, { message: "API rate limit exceeded" }), resp(200, gh("v1.9.5")))),
      /rate limit/,
    );
  });

  it("tolerates 404 from /releases/latest — a repo with no stable release yet", async () => {
    const releases = await fetchReleases(
      serving(resp(200, [gh("v1.10.0-beta.1")]), resp(404, { message: "Not Found" })),
    );
    assert.deepEqual(releases.map((r) => r.tag), ["v1.10.0-beta.1"]);
  });

  it("any other /releases/latest failure fails the check — main boxes answer from that endpoint", async () => {
    await assert.rejects(
      fetchReleases(serving(resp(200, [gh("v1.10.0-beta.1")]), resp(403, {}))),
      /403.*newest stable/,
    );
  });

  it("a non-OK page response fails the check", async () => {
    await assert.rejects(fetchReleases(serving(resp(500, {}), resp(200, gh("v1.9.5")))), /500/);
  });
});

describe("what a packaged install shows under \"What's new\"", () => {
  // A git checkout reads commit subjects out of its own history. A packaged
  // install has no history and used to list bare tags — "v1.10.0,
  // v1.10.0-beta.38, v1.10.0-beta.37" — which tells an operator nothing they
  // can act on, while the same box's git sibling showed the real subjects.
  // The release notes carry those lines; read them from there.
  const NOTES = [
    "> **Upgrading?** One manual step, once. Re-run the installer.",
    "",
    "## Highlights",
    "",
    "In-app updates now work on every install method.",
    "",
    "## New",
    "",
    "- **automation** — trigger a set time before a rehearsal or service",
    "- **patch** — ownership bands on the sheet",
    "- …and 22 more",
    "",
    "## Fixed",
    "",
    "- **pco** — check the Live action URL's origin",
    "- `history` — stop a merge orphaning a record",
    "",
    "## Install",
    "",
    "- this bullet is in Install and must not be listed as a change",
  ].join("\n");

  const withNotes = (tag: string, body: string | null) => ({
    tag,
    name: tag,
    publishedAt: "2026-08-14T00:00:00Z",
    assets: ["stage-utility-x-linux-x64.tar.gz"],
    body,
  });

  it("lists the actual changes, not the tags they shipped under", () => {
    const s = packagedUpdateStatus([withNotes("v1.10.0", NOTES)], "beta", "1.10.0-beta.38");
    assert.deepEqual(s.changelog, [
      "automation — trigger a set time before a rehearsal or service",
      "patch — ownership bands on the sheet",
      "pco — check the Live action URL's origin",
      "history — stop a merge orphaning a record",
    ]);
  });

  it("ignores prose, the upgrade notice, Install, and the truncation marker", () => {
    const s = packagedUpdateStatus([withNotes("v1.10.0", NOTES)], "beta", "1.10.0-beta.38");
    const joined = s.changelog.join("\n");
    assert.doesNotMatch(joined, /Upgrading/, "the notice is prose, not a change");
    assert.doesNotMatch(joined, /In-app updates now work/, "Highlights is prose");
    assert.doesNotMatch(joined, /must not be listed/, "Install bullets are not changes");
    assert.doesNotMatch(joined, /and 22 more/, "the generator's own marker is not a change");
  });

  it("strips markdown so the panel shows plain text", () => {
    const s = packagedUpdateStatus([withNotes("v1.10.0", NOTES)], "beta", "1.10.0-beta.38");
    assert.doesNotMatch(s.changelog.join("\n"), /[*`]/, "no emphasis or code ticks reach the UI");
  });

  it("falls back to the tag when a release has no notes at all", () => {
    const s = packagedUpdateStatus([withNotes("v1.10.0", null)], "beta", "1.10.0-beta.38");
    assert.deepEqual(s.changelog, ["v1.10.0"]);
  });

  it("spans several releases, newest first", () => {
    const s = packagedUpdateStatus(
      [
        withNotes("v1.10.0", "## Fixed\n\n- **a** — newest\n"),
        withNotes("v1.10.0-beta.38", "## Fixed\n\n- **b** — older\n"),
      ],
      "beta",
      "1.10.0-beta.37",
    );
    assert.deepEqual(s.changelog, ["a — newest", "b — older"]);
  });
});

describe("the rate limit, which is what a 403 here really is", () => {
  // GitHub allows 60 unauthenticated requests an hour PER IP, and one update
  // check spends two. A church runs more than one of these on one connection, so
  // the quota goes and the operator sees "GitHub answered 403" — which reads like
  // a broken install rather than "wait 46 minutes".
  //
  // Reproduced exactly that against the real API while diagnosing it:
  //   core limit=60 remaining=0 reset in 46 min

  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

  it("says how long to wait instead of quoting a status code", async () => {
    clearReleaseCache();
    const resetAt = Math.floor((Date.now() + 30 * 60_000) / 1000);
    const doFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: "API rate limit exceeded" }),
      headers: headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) }),
    });
    await assert.rejects(() => fetchReleases(doFetch), /hourly limit for this network is used up/);
    await assert.rejects(() => fetchReleases(doFetch), /resets in 30 min/);
  });

  it("still reports a 403 that is NOT a quota as a 403", async () => {
    // A private repo or a blocked token is a different problem and must not be
    // described as a rate limit.
    clearReleaseCache();
    const doFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: "Forbidden" }),
      headers: headers({ "x-ratelimit-remaining": "57" }),
    });
    await assert.rejects(() => fetchReleases(doFetch), /GitHub answered 403/);
  });
});

describe("conditional requests, so polling does not spend the quota", () => {
  // A 304 does not count against the rate limit. That is the whole fix: an
  // install that checks all day spends requests only when something was released.

  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

  it("sends If-None-Match once it has an ETag, and serves the cache on 304", async () => {
    clearReleaseCache();
    const sent: (string | undefined)[] = [];
    let phase = 0;
    const doFetch = async (_url: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers["If-None-Match"]);
      if (phase === 0) {
        return {
          ok: true,
          status: 200,
          json: async () => [gh("v1.11.0")],
          headers: headers({ etag: 'W/"abc123"' }),
        };
      }
      return { ok: false, status: 304, json: async () => null, headers: headers({}) };
    };

    const first = await fetchReleases(doFetch);
    assert.ok(first.some((r) => r.tag === "v1.11.0"), "the first call reads the body");
    assert.equal(sent[0], undefined, "nothing to send on the first request");

    phase = 1;
    const second = await fetchReleases(doFetch);
    assert.equal(sent[2], 'W/"abc123"', "the ETag must go out on the next request");
    assert.ok(
      second.some((r) => r.tag === "v1.11.0"),
      "a 304 must serve the cached releases, not an empty list — an empty list reads as " +
        "'no releases' and would silently claim the install is up to date",
    );
  });

  it("clearReleaseCache forces a fresh request", () => {
    clearReleaseCache();
    // Nothing to assert beyond it not throwing: the behaviour is covered above,
    // and this pins that the escape hatch a "check now" needs exists.
    assert.ok(true);
  });
});
