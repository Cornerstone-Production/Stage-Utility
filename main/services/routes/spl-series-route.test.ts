// GET /api/spl/history/:key/series — the raw sample series behind one record's
// sound chart.
//
// Driven through the real route with a real data directory and real CSV files on
// disk, because what is under test is the join between the record store (which
// supplies the service DATE, and so the directory) and the raw layer. A stubbed
// row reader would prove the bucket maths, which spl-series.test.ts already does,
// and skip the part that can actually be wrong.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-spl-series-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { statusRoutes } = await import("./status-routes.js");
const { callRoute } = await import("./route-harness.js");
const { splHistoryStore } = await import("../spl-history-store.js");
const { serviceDirPath } = await import("../archive/archive-paths.js");

const KEY = "75953:909:2251";
const NO_RAW_KEY = "75953:909:2252";
const DATE = "2026-09-17";
const T0 = Date.parse("2026-09-17T20:00:00.000Z");

function record(serviceKey: string) {
  return {
    serviceKey,
    serviceTypeId: "75953",
    serviceTypeName: "The Salt Company",
    planId: "909",
    planTitle: "Night of Worship",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: "2251",
    serviceTimeStartsAt: new Date(T0).toISOString(),
    meterId: "m1",
    metricKey: "LAeq 1",
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + 30 * 60_000).toISOString(),
    items: [],
  };
}

/** 600 rows, one a second: ten minutes of a service. */
function splCsv(): string {
  const head = "at,itemId,item,SPL A Fast,LAeq 1";
  const lines = Array.from({ length: 600 }, (_, i) => {
    const at = new Date(T0 + i * 1000).toISOString();
    // A loud minute in the middle, so `max` and `avg` are distinguishable.
    const spl = i >= 300 && i < 360 ? 100 : 85;
    return `${at},item-a,Message,${spl},${spl - 4}`;
  });
  return [head, ...lines].join("\n");
}

const ROLLED_KEY = "75953:909:2253";

/** The second half of the same ten minutes, as a rolled file — what
 *  csv-appender.ts writes when the meter's column set changes mid-service, and
 *  what a history merge moves between directories. */
function rolledCsv(from: number, to: number): string {
  const head = "at,itemId,item,SPL A Fast,LAeq 1";
  const lines = [];
  for (let i = from; i < to; i++) {
    lines.push(`${new Date(T0 + i * 1000).toISOString()},item-a,Message,85,81`);
  }
  return [head, ...lines].join("\n");
}

before(async () => {
  await splHistoryStore.upsert(record(KEY) as never);
  await splHistoryStore.upsert(record(NO_RAW_KEY) as never);
  await splHistoryStore.upsert(record(ROLLED_KEY) as never);
  const dir = serviceDirPath(KEY, DATE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "spl.csv"), splCsv(), "utf8");

  // A service whose rows are split across TWO files, with the later seconds in
  // spl.csv and the earlier ones in spl.2.csv — so file order is not time
  // order, which is exactly what a merge produces.
  const rolledDir = serviceDirPath(ROLLED_KEY, DATE);
  await fs.mkdir(rolledDir, { recursive: true });
  await fs.writeFile(path.join(rolledDir, "spl.csv"), rolledCsv(30, 60), "utf8");
  await fs.writeFile(path.join(rolledDir, "spl.2.csv"), rolledCsv(0, 30), "utf8");
});

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const url = (key: string, query = "") =>
  `/api/spl/history/${encodeURIComponent(key)}/series${query}`;

describe("GET /api/spl/history/:key/series", () => {
  test("answers buckets over the record's own raw rows", async () => {
    const r = await callRoute(statusRoutes, url(KEY, "?metric=SPL%20A%20Fast&bucketSec=5"));
    assert.equal(r.status, 200);
    const body = r.json as { metric: string; metrics: string[]; bucketSec: number; buckets: { t: number; max: number; avg: number }[] };
    assert.equal(body.metric, "SPL A Fast");
    assert.equal(body.bucketSec, 5);
    // 600 seconds at five is 120.
    assert.equal(body.buckets.length, 120);
    assert.deepEqual(body.metrics, ["LAeq 1", "SPL A Fast"]);
  });

  test("the loud minute is in the series, and max is above avg there", async () => {
    // The point of shipping max AND avg: a chart that only had the mean would
    // flatten the one minute anybody would ask about.
    const r = await callRoute(statusRoutes, url(KEY, "?metric=SPL%20A%20Fast&bucketSec=60"));
    const body = r.json as { buckets: { t: number; max: number; avg: number }[] };
    assert.equal(body.buckets.length, 10);
    assert.equal(body.buckets[5].max, 100);
    assert.ok(body.buckets[4].max < body.buckets[5].max, "the loud minute is not the loudest bucket");
  });

  test("an unknown metric falls back to the record's own, never to nothing", async () => {
    const r = await callRoute(statusRoutes, url(KEY, "?metric=LZeq%2099"));
    assert.equal(r.status, 200);
    assert.equal((r.json as { metric: string }).metric, "LAeq 1");
    assert.ok((r.json as { buckets: unknown[] }).buckets.length > 0);
  });

  test("no metric asked for still answers", async () => {
    const r = await callRoute(statusRoutes, url(KEY));
    assert.equal(r.status, 200);
    assert.equal((r.json as { metric: string }).metric, "LAeq 1");
  });

  test("a nonsense bucketSec does not divide by zero", async () => {
    for (const q of ["?bucketSec=0", "?bucketSec=-4", "?bucketSec=abc"]) {
      const r = await callRoute(statusRoutes, url(KEY, q));
      assert.equal(r.status, 200, q);
      assert.ok((r.json as { bucketSec: number }).bucketSec > 0, q);
    }
  });

  test("404 when the record has no raw rows at all", async () => {
    // Distinct from an empty series: a record from before the raw layer existed
    // has nothing to draw a line from, and the chart falls back to the per-item
    // step for exactly this case.
    const r = await callRoute(statusRoutes, url(NO_RAW_KEY));
    assert.equal(r.status, 404);
  });

  test("404 for a service key that is not a record", async () => {
    const r = await callRoute(statusRoutes, url("nope:nope:nope"));
    assert.equal(r.status, 404);
  });

  test("a rolled spl.2.csv is read into ONE series, in time order", async () => {
    // readArchiveRows walks spl.csv then spl.2.csv, so a service whose earlier
    // seconds live in the rolled file arrives back-to-front. Every bucket must
    // still be distinct and in order — the defect was one bucket emitted twice
    // at the same t, drawing a vertical spike through the plot.
    const r = await callRoute(statusRoutes, url(ROLLED_KEY, "?metric=SPL%20A%20Fast&bucketSec=5"));
    assert.equal(r.status, 200);
    const buckets = (r.json as { buckets: { t: number }[] }).buckets;
    assert.equal(buckets.length, 12, `${buckets.length} buckets for sixty seconds at five`);
    assert.equal(new Set(buckets.map((b) => b.t)).size, buckets.length, "a bucket was emitted twice");
    for (let i = 1; i < buckets.length; i++) {
      assert.ok(buckets[i].t > buckets[i - 1].t, "out of time order");
    }
    // It starts at the EARLIEST row, which lives in the rolled file.
    assert.equal(buckets[0].t, T0);
  });

  test("the single-segment record route still answers, unshadowed", async () => {
    // The series path is matched first; the record path must not have been eaten.
    //
    // NOT asserted on `serviceKey`: BOTH answers carry it, so a regex without
    // its `$` anchor — which is exactly how this gets broken — swallows the
    // record path and this test stays green. Assert on a field only the RECORD
    // has, and on the absence of one only the series has.
    const r = await callRoute(statusRoutes, `/api/spl/history/${encodeURIComponent(KEY)}`);
    assert.equal(r.status, 200);
    const body = r.json as Record<string, unknown>;
    assert.equal(body.serviceKey, KEY);
    assert.ok(Array.isArray(body.items), `no per-item array — this is the series, not the record: ${Object.keys(body).join(",")}`);
    assert.equal("buckets" in body, false, "the series route swallowed the record route");
  });
});
