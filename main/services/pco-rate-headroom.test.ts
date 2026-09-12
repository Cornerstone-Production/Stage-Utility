// Planning Center's rate headers, and what the client does about them.
//
// PCO puts X-PCO-API-Request-Rate-Limit / -Period / -Count on EVERY response.
// The client read none of them and reacted only to a 429 that had already
// happened — by which point a display has missed a countdown tick. Its comments
// reasoned in prose about "well under 100 per 20s", which is precisely the
// hard-coded value PCO's own docs say never to assume: the limit is dynamic and
// per-endpoint, and PCO staff say on the record to rely on these headers.
//
// These drive the REAL pcoService with a stubbed fetch rather than a copy of the
// gate. pco-concurrency.test.ts pins the gate's shape against a local copy, which
// is fine for the shape and useless for this: the bug guarded here is the real
// client failing to tighten, and a copy of the gate cannot fail that way.

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";

import { buildLogChecks } from "./log-checks.js";
import {
  PcoRateLimit,
  RATE_COUNT_HEADER,
  RATE_LIMIT_HEADER,
  RATE_PERIOD_HEADER,
  readRateHeaders,
} from "./pco-rate-limit.js";
import { pcoService } from "./pco-service.js";

/** What the stub reports on the next response. Mutated between phases. */
let headers: Record<string, string> = {};
/** Concurrency actually reached inside the stub — the thing being pinned. */
let inFlight = 0;
let peak = 0;

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realLog = console.log;
let warns: string[] = [];
let logs: string[] = [];

/** A fetch that holds the connection open briefly so overlap is observable. */
function stubFetch(): void {
  globalThis.fetch = (async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight--;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(headers),
      json: async () => ({ data: [], included: [] }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof fetch;
}

/** Rate headers describing `count` of `limit` used. */
function rate(count: number, limit = 100, periodSec = 20): Record<string, string> {
  return {
    [RATE_LIMIT_HEADER]: String(limit),
    [RATE_PERIOD_HEADER]: String(periodSec),
    [RATE_COUNT_HEADER]: String(count),
  };
}

/** N concurrent reads through the real client, each a distinct cache key. */
async function burst(n: number): Promise<void> {
  await Promise.all(
    Array.from({ length: n }, (_, i) => pcoService.listTeamNames("app", "sec", `st-${i}`)),
  );
}

describe("PCO rate headroom", () => {
  beforeEach(() => {
    headers = rate(1);
    inFlight = 0;
    peak = 0;
    warns = [];
    logs = [];
    console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(" "));
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    pcoService.clearCache();
    stubFetch();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.log = realLog;
    pcoService.clearCache();
    // Leave the shared singleton clear — a tight flag carried into another file's
    // tests would throttle them and read as a flake.
    pcoService.resetRateLimit();
  });

  test("with headroom, a burst runs at the normal ceiling", async () => {
    headers = rate(5);
    await burst(12);
    assert.equal(peak, 4, `expected the normal ceiling of 4 concurrent, peaked at ${peak}`);
    assert.equal(pcoService.rateLimitTight(), false);
  });

  test("THE GUARD: past the high-water mark the gate drops to one in flight", async () => {
    // One response over the mark is enough to set the flag.
    headers = rate(90);
    await pcoService.listServiceTypes("app", "sec");
    assert.equal(pcoService.rateLimitTight(), true, "90 of 100 is past the 0.75 mark");

    peak = 0;
    pcoService.clearCache();
    await burst(12);
    assert.equal(
      peak,
      1,
      `past the high-water mark the client must stop spending its remaining headroom four requests ` +
        `at a time. Peaked at ${peak} concurrent — the gate is still reading the untightened ceiling.`,
    );
  });

  test("the gate opens again once PCO reports room", async () => {
    headers = rate(90);
    await pcoService.listServiceTypes("app", "sec");
    assert.equal(pcoService.rateLimitTight(), true);

    headers = rate(10);
    pcoService.clearCache();
    await pcoService.listServiceTypes("app", "sec");
    assert.equal(pcoService.rateLimitTight(), false);

    peak = 0;
    pcoService.clearCache();
    await burst(12);
    assert.equal(peak, 4, `expected the ceiling back at 4, peaked at ${peak}`);
  });

  test("THE GUARD: the transition is logged once, not once per request", async () => {
    headers = rate(95);
    await burst(12);
    const tightLines = warns.filter((l) => l.includes("rate-limit headroom is tight"));
    assert.equal(
      tightLines.length,
      1,
      `one line per episode, not one per request. Saw ${tightLines.length}: ${tightLines.join(" | ")}`,
    );
    assert.match(tightLines[0], /95\/100 requests used in PCO's 20s/);

    headers = rate(5);
    pcoService.clearCache();
    await burst(12);
    const clearLines = logs.filter((l) => l.includes("rate-limit headroom recovered"));
    assert.equal(
      clearLines.length,
      1,
      `one recovery line per episode. Saw ${clearLines.length}: ${clearLines.join(" | ")}`,
    );
  });

  test("the hysteresis gap stops a request straddling the mark from flapping", async () => {
    headers = rate(80);
    await pcoService.listServiceTypes("app", "sec");
    assert.equal(pcoService.rateLimitTight(), true);

    // Between the clear mark (0.5) and the tight mark (0.75): still holding, and
    // silent. A single threshold would have logged a recovery here and a fresh
    // "tight" on the next request over the line, forever.
    warns = [];
    logs = [];
    for (const count of [70, 60, 55, 70]) {
      headers = rate(count);
      pcoService.clearCache();
      await pcoService.listServiceTypes("app", "sec");
      assert.equal(pcoService.rateLimitTight(), true, `${count}/100 is inside the gap and must stay held`);
    }
    assert.deepEqual(
      [...warns, ...logs].filter((l) => l.includes("rate-limit headroom")),
      [],
      "nothing crossed a threshold, so nothing should have been said",
    );
  });

  test("the headers are read off a 429 too — a refused request still counted", async () => {
    // The response that matters most is the one PCO refused. Reading the headers
    // in pcoFetch rather than on the success path is what makes that true.
    let served = 0;
    globalThis.fetch = (async () => {
      served++;
      return {
        ok: served > 1,
        status: served > 1 ? 200 : 429,
        statusText: served > 1 ? "OK" : "Too Many Requests",
        headers: new Headers(served > 1 ? rate(5) : { ...rate(100), "Retry-After": "0" }),
        json: async () => ({ data: [], included: [] }),
        text: async () => "{}",
      } as unknown as Response;
    }) as typeof fetch;

    await pcoService.listServiceTypes("app", "sec");
    assert.ok(served >= 2, "the 429 should have been retried");
    const tight = warns.filter((l) => l.includes("rate-limit headroom is tight"));
    assert.equal(tight.length, 1, "the 429's own headers must be read");
  });

  test("the headroom reaches the /log health strip", async () => {
    headers = rate(42, 100, 20);
    await pcoService.listServiceTypes("app", "sec");
    const checks = buildLogChecks({
      version: "test",
      uptimeSec: 1,
      timeZone: "UTC",
      followingHost: false,
      errors: 0,
      warnings: 0,
      states: [],
      descriptors: [],
      pcoRate: pcoService.rateLimitStatus(),
    });
    assert.deepEqual(checks.pcoRate, { count: 42, limit: 100, periodSec: 20, tight: false });
  });

  test("no PCO traffic yet means no chip, not a made-up number", () => {
    pcoService.resetRateLimit();
    assert.equal(pcoService.rateLimitStatus(), null);
    const checks = buildLogChecks({
      version: "test",
      uptimeSec: 1,
      timeZone: "UTC",
      followingHost: false,
      errors: 0,
      warnings: 0,
      states: [],
      descriptors: [],
      pcoRate: pcoService.rateLimitStatus(),
    });
    assert.equal(checks.pcoRate, null);
  });
});

describe("reading the three headers", () => {
  test("all three, or nothing", () => {
    const at = 1_000;
    assert.deepEqual(readRateHeaders(new Headers(rate(7, 40, 20)), at), {
      limit: 40,
      periodSec: 20,
      count: 7,
      at,
    });
    // A limit with no count says nothing about headroom; a count with no limit is
    // a division by zero dressed as data. Either alone must not put the app into
    // a permanent hold.
    assert.equal(readRateHeaders(new Headers({ [RATE_LIMIT_HEADER]: "40" }), at), null);
    assert.equal(readRateHeaders(new Headers({ [RATE_COUNT_HEADER]: "7" }), at), null);
    assert.equal(
      readRateHeaders(new Headers({ ...rate(7), [RATE_LIMIT_HEADER]: "0" }), at),
      null,
      "a limit of zero would divide by zero",
    );
    assert.equal(readRateHeaders(new Headers({ ...rate(7), [RATE_COUNT_HEADER]: "many" }), at), null);
  });

  test("a missing period costs precision, not correctness", () => {
    const at = 1_000;
    const obs = readRateHeaders(
      new Headers({ [RATE_LIMIT_HEADER]: "40", [RATE_COUNT_HEADER]: "7" }),
      at,
    );
    assert.deepEqual(obs, { limit: 40, periodSec: 0, count: 7, at });
  });

  test("PCO's limit is per endpoint, so a limit of 10 is honoured as readily as 100", () => {
    // PCO staff report endpoints answering with a limit of 10 where the
    // documented default is 100. Nothing here may assume the bigger number.
    const rl = new PcoRateLimit(2, 20, 0.75, 0.5);
    assert.equal(rl.observe({ limit: 10, periodSec: 20, count: 8, at: 0 }, 0), "tight");
    assert.equal(rl.tight(0), true);
    assert.equal(rl.status(0)?.remaining, 2);
  });

  test("a stale observation stops throttling, and the next episode still logs", () => {
    const rl = new PcoRateLimit(2, 20, 0.75, 0.5);
    rl.observe({ limit: 100, periodSec: 20, count: 90, at: 0 }, 0);
    assert.equal(rl.tight(0), true);
    // Two periods on, the window it described is long gone.
    assert.equal(rl.tight(41_000), false, "an episode that ended must not throttle the app forever");
    // And the flag does not silently swallow the next episode's line.
    assert.equal(
      rl.observe({ limit: 100, periodSec: 20, count: 90, at: 100_000 }, 100_000),
      "tight",
      "a new episode after a gap has to announce itself",
    );
  });
});
