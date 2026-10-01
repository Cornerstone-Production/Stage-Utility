// GET /photos?u=…&s=… driven through the real handler and the real disk cache.
//
// Only Planning Center is faked: `fetch` is stubbed to answer as PCO's resizer
// does, keyed on the exact URL it is asked for. Everything between — the size
// snapping, the geometry rewrite, the cache file names, the fallback, the
// Cache-Control header — is the code a display gets.
//
// What matters here, each with a test:
//   - a sized request fetches the SIZED copy from PCO and is cached like any
//     other photo, immutable;
//   - the size is part of the cache key, so a full-size photo already on disk
//     from before sizes existed is never served as the small one;
//   - when the small copy is not to hand, the original stands in for it rather
//     than a broken image — within 1.5 s if it is on disk, never pinned
//     immutable at the sized URL, and logged when PCO failed it;
//   - a small copy PCO failed is not asked for again for five minutes.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// proxy-routes pulls in the stage controller, which resolves the data directory
// at import, and the photo cache writes under it. Point it somewhere disposable
// BEFORE that happens — never at the operator's real ~/.stage-utility.
const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "photo-proxy-route-"));
process.env.STAGE_UTILITY_DATA = DATA;

const { proxyRoutes } = await import("./proxy-routes.js");
const { callRoute } = await import("./route-harness.js");
const { __resetSizedFailuresForTests, __settlePhotoFetchesForTests } = await import("../photo-cache.js");

/** The shape PCO serves, for a person who does not exist. */
const AVATAR = "https://avatars.planningcenteronline.com/uploads/person/100000001-1600000000/avatar.2.png";
/** A whole-image geometry, the kind that was ~1.2 MB. */
const WHOLE = `${AVATAR}?g=1000x1000`;
/** What the route should ask PCO for at `s=256`. */
const WHOLE_256 = `${AVATAR}?g=256x256`;

const FULL_BYTES = "full-size-original";
const SMALL_BYTES = "256px-copy";

/** Every URL PCO was asked for, in order. */
let fetched: string[];
/** What PCO answers, by exact URL, optionally after `delayMs`. Anything unlisted is a 404; `hang` never answers. */
let answers: Map<string, { status: number; body: string; delayMs?: number } | "hang">;
let warnings: string[];
let errors: string[];
/** Fetches left hanging by a `hang` answer, released after each test. */
const hung: Array<(r: Response) => void> = [];

const photoRequest = (u: string, extra = "") => callRoute(proxyRoutes, `/photos?u=${encodeURIComponent(u)}${extra}`);

beforeEach(async () => {
  // A fresh cache per test: a photo left on disk by the previous test would be
  // served without a fetch and make every assertion about fetching vacuous.
  await fsp.rm(path.join(DATA, "cache", "photos"), { recursive: true, force: true });
  await fsp.mkdir(path.join(DATA, "cache", "photos"), { recursive: true });
  fetched = [];
  answers = new Map();
  warnings = [];
  errors = [];
  __resetSizedFailuresForTests();
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(u);
    const a = answers.get(u) ?? { status: 404, body: "" };
    // PCO unreachable: a request that neither answers nor fails until the test
    // is over, when afterEach releases it.
    if (a === "hang") return new Promise<Response>((resolve) => hung.push(resolve));
    if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
    return new Response(a.body, { status: a.status, headers: { "content-type": "image/png" } });
  });
  mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  // fetchPhoto reports a failed attempt on console.error.
  mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  for (const release of hung.splice(0)) release(new Response("", { status: 404 }));
  // Background fetches finish inside the test that started them, never in the next.
  await __settlePhotoFetchesForTests();
  mock.restoreAll();
  mock.timers.reset();
});

describe("GET /photos with a size", () => {
  it("fetches the sized copy from PCO and caches it immutable", async () => {
    answers.set(WHOLE_256, { status: 200, body: SMALL_BYTES });

    const r = await photoRequest(WHOLE, "&s=256");

    assert.equal(r.status, 200);
    assert.equal(r.body, SMALL_BYTES);
    assert.deepEqual(fetched, [WHOLE_256], "asked PCO for the full-size original");
    assert.equal(r.headers["Cache-Control"], "public, max-age=31536000, immutable");
  });

  it("snaps an off-ladder size up to a rung, so it cannot mint a cache entry per value", async () => {
    answers.set(WHOLE_256, { status: 200, body: SMALL_BYTES });

    const r = await photoRequest(WHOLE, "&s=250");

    assert.equal(r.body, SMALL_BYTES);
    assert.deepEqual(fetched, [WHOLE_256]);
  });

  it("serves the URL as given when there is no size, or a junk one", async () => {
    answers.set(WHOLE, { status: 200, body: FULL_BYTES });

    for (const extra of ["", "&s=abc", "&s=0", "&s=99999"]) {
      const r = await photoRequest(WHOLE, extra);
      assert.equal(r.body, FULL_BYTES, extra || "(no s)");
    }
    assert.deepEqual(fetched, [WHOLE], "fetched once, then served from disk");
  });

  it("never serves a full-size photo already on disk as the small one", async () => {
    // The state every server upgrading to this is in: the originals are cached.
    answers.set(WHOLE, { status: 200, body: FULL_BYTES });
    answers.set(WHOLE_256, { status: 200, body: SMALL_BYTES });
    assert.equal((await photoRequest(WHOLE)).body, FULL_BYTES);

    const sized = await photoRequest(WHOLE, "&s=256");
    assert.equal(sized.body, SMALL_BYTES, "the cached original answered a sized request");
    assert.equal(sized.headers["Cache-Control"], "public, max-age=31536000, immutable");

    // And the two stay apart in both directions.
    assert.equal((await photoRequest(WHOLE)).body, FULL_BYTES);
    assert.equal((await photoRequest(WHOLE, "&s=256")).body, SMALL_BYTES);
    assert.deepEqual(fetched, [WHOLE, WHOLE_256], "each size fetched once, then served from disk");
  });

  it("makes one upstream fetch for simultaneous requests for one photo", async () => {
    answers.set(WHOLE_256, { status: 200, body: SMALL_BYTES });

    const all = await Promise.all([1, 2, 3, 4].map(() => photoRequest(WHOLE, "&s=256")));

    for (const r of all) assert.equal(r.body, SMALL_BYTES);
    assert.deepEqual(fetched, [WHOLE_256], "each request fetched and wrote the same file");
  });
});

describe("GET /photos when the sized copy fails", () => {
  it("serves the original rather than a broken image, and says so", async () => {
    // PCO answers an out-of-range geometry with a 504, measured; any failure
    // of the sized URL alone takes this path.
    answers.set(WHOLE_256, { status: 504, body: "" });
    answers.set(WHOLE, { status: 200, body: FULL_BYTES });

    const r = await photoRequest(WHOLE, "&s=256");

    assert.equal(r.status, 200);
    assert.equal(r.body, FULL_BYTES);
    assert.ok(
      warnings.some((w) => w.startsWith("[photo-cache]") && w.includes("256px")),
      `no tagged line for the fallback: ${JSON.stringify(warnings)}`,
    );
  });

  it("does not pin the fallback, and asks PCO again once five minutes have passed", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-27T15:00:00Z") });
    answers.set(WHOLE_256, { status: 504, body: "" });
    answers.set(WHOLE, { status: 200, body: FULL_BYTES });

    const first = await photoRequest(WHOLE, "&s=256");
    assert.equal(first.headers["Cache-Control"], "no-cache");

    // PCO recovers, but inside the window the failed copy is not asked for: an
    // outage costs one fetch per photo, not one per load.
    answers.set(WHOLE_256, { status: 200, body: SMALL_BYTES });
    const soon = await photoRequest(WHOLE, "&s=256");
    await __settlePhotoFetchesForTests();
    assert.equal(soon.body, FULL_BYTES);
    // Two: the first request's attempt and its one retry.
    assert.equal(fetched.filter((u) => u === WHOLE_256).length, 2, "asked for the failed copy again at once");

    // After it, the sized request reaches PCO rather than being answered from a
    // disk entry the fallback wrote under the sized key.
    mock.timers.tick(5 * 60 * 1000 + 1);
    const recovered = await photoRequest(WHOLE, "&s=256");
    assert.equal(recovered.body, SMALL_BYTES);
    assert.equal(recovered.headers["Cache-Control"], "public, max-age=31536000, immutable");
  });

  it("serves an original already on disk within 1.5 s when PCO is unreachable", { timeout: 5000 }, async () => {
    const other = `${AVATAR.replace("100000001", "100000002")}?g=1000x1000`;
    const other256 = `${AVATAR.replace("100000001", "100000002")}?g=256x256`;
    answers.set(other, { status: 200, body: FULL_BYTES });
    assert.equal((await photoRequest(other)).body, FULL_BYTES);
    answers.set(other256, "hang");

    const started = performance.now();
    const r = await photoRequest(other, "&s=256");
    const ms = performance.now() - started;

    assert.equal(r.body, FULL_BYTES);
    assert.equal(r.headers["Cache-Control"], "no-cache");
    // fetchPhoto's own timeouts would hold it for 16 s.
    assert.ok(ms < 3000, `waited ${Math.round(ms)} ms on PCO for a photo already on disk`);
  });

  it("404s only when the original cannot be had either, and says so for each", async () => {
    const r = await photoRequest(WHOLE, "&s=256");
    assert.equal(r.status, 404);
    // One line for the small copy, which claims nothing about the original, and
    // the original's own failure as a line of its own.
    assert.deepEqual(warnings, [
      `[photo-cache] PCO did not give a 256px copy of ${WHOLE}; serving it at its own geometry where it can be, retrying in 5 min`,
    ]);
    assert.ok(errors.some((e) => e.includes(`Failed to fetch ${WHOLE}: 404`)), JSON.stringify(errors));
  });

  it("writes one line for one failure, however many requests shared it", async () => {
    answers.set(WHOLE_256, { status: 504, body: "" });
    answers.set(WHOLE, { status: 200, body: FULL_BYTES });

    const all = await Promise.all([1, 2, 3, 4].map(() => photoRequest(WHOLE, "&s=256")));

    for (const r of all) assert.equal(r.body, FULL_BYTES);
    assert.equal(warnings.filter((w) => w.includes("256px")).length, 1, JSON.stringify(warnings));
  });

  it("serves a small copy that arrives after the wait, if the original cannot be had", { timeout: 5000 }, async () => {
    const base = AVATAR.replace("100000001", "100000004");
    answers.set(`${base}?g=256x256`, { status: 200, body: SMALL_BYTES, delayMs: 2000 });

    const r = await photoRequest(`${base}?g=1000x1000`, "&s=256");

    assert.equal(r.status, 200, "gave up on the small copy when the original failed");
    assert.equal(r.body, SMALL_BYTES);
    assert.equal(r.headers["Cache-Control"], "public, max-age=31536000, immutable");
  });

  it("fetches the original alongside once the small copy is slow, with nothing on disk", { timeout: 5000 }, async () => {
    // Its own person: the hung fetch stays in flight until afterEach.
    const base = AVATAR.replace("100000001", "100000003");
    answers.set(`${base}?g=256x256`, "hang");
    answers.set(`${base}?g=1000x1000`, { status: 200, body: FULL_BYTES });

    const started = performance.now();
    const r = await photoRequest(`${base}?g=1000x1000`, "&s=256");
    const ms = performance.now() - started;

    assert.equal(r.body, FULL_BYTES);
    assert.equal(r.headers["Cache-Control"], "no-cache");
    // Waiting out the small copy before starting the original would be 16 s.
    assert.ok(ms < 3000, `waited ${Math.round(ms)} ms before fetching the original`);
  });

  it("refuses a host outside PCO once, without a fallback", async () => {
    const r = await photoRequest("http://192.168.1.1/admin.png?g=1000x1000", "&s=256");
    assert.equal(r.status, 404);
    assert.deepEqual(fetched, [], "fetched a refused host");
    // One refusal, not a refusal for the sized URL, another for the original,
    // and a line claiming a fallback that never happened.
    assert.deepEqual(warnings, [
      "[photo-cache] refused to fetch a photo from outside PCO: http://192.168.1.1/admin.png?g=1000x1000",
    ]);
  });
});
