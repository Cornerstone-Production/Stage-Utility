// The SPL summary carries a PEAK as well as an energy average.
//
// It exists so a caller asking "how loud did this service get" does not pull
// the whole per-item record: the Trends chart's sound measure plots one point
// per recording across up to 52 weeks, which would otherwise be hundreds of
// files read to answer one number each. The summary was already loaded by every
// page that needs it.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-spl-summary-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { splHistoryStore } = await import("./spl-history-store.js");

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

/** One recording of two items. Each item's metrics are given verbatim. */
function record(serviceKey: string, items: Record<string, unknown>[]): ServiceSplHistory {
  return {
    serviceKey,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    planId: "p",
    planTitle: "Sunday",
    seriesTitle: null,
    serviceDate: "2026-09-06",
    serviceTimeId: serviceKey,
    serviceTimeStartsAt: "2026-09-06T14:00:00.000Z",
    meterId: "m",
    metricKey: null,
    startedAt: "2026-09-06T14:00:00.000Z",
    endedAt: "2026-09-06T15:20:00.000Z",
    items: items.map((metrics, i) => ({
      itemId: `i${i}`,
      title: `Item ${i}`,
      sequence: i,
      metrics,
      maxSpl: null,
      sampleCount: 100,
      startedAt: "2026-09-06T14:00:00.000Z",
      endedAt: "2026-09-06T14:20:00.000Z",
    })),
  } as unknown as ServiceSplHistory;
}

const summaryFor = async (key: string) =>
  (await splHistoryStore.summary()).find((s) => s.serviceKey === key)!;

describe("the peak in a summary", () => {
  it("is the loudest reading across the items, not an energy combination", async () => {
    // A peak does not average. The quiet welcome and the loud worship set
    // combine to an Leq between them, and to the LOUDER of the two peaks.
    await splHistoryStore.upsert(record("a", [
      { "LAeq 10": { max: 96.4, avg: 90, leq: 91.2, count: 400 } },
      { "LAeq 10": { max: 101.8, avg: 94, leq: 95.6, count: 900 } },
    ]));
    const m = (await summaryFor("a")).metrics["LAeq 10"];
    assert.equal(m.max, 101.8);
    assert.ok(m.leq != null && m.leq > 91.2 && m.leq < 101.8, `the Leq is still an energy average: ${m.leq}`);
  });

  it("keeps a metric that has a peak and no Leq", async () => {
    // A legacy capture has maxima and no Leq at all. Dropping the metric on a
    // missing Leq threw away peaks that were really there, and the Trends
    // chart's sound measure reads the peak.
    await splHistoryStore.upsert(record("b", [
      { "SPL A Fast": { max: 108.2, avg: null, leq: null, count: 300 } },
    ]));
    const metrics = (await summaryFor("b")).metrics;
    assert.ok("SPL A Fast" in metrics, `the metric was dropped: ${Object.keys(metrics).join(", ")}`);
    assert.equal(metrics["SPL A Fast"].max, 108.2);
    assert.equal(metrics["SPL A Fast"].leq, null);
  });

  it("leaves out a metric with neither", async () => {
    await splHistoryStore.upsert(record("c", [
      { "Ghost": { max: null, avg: 70, leq: null, count: 0 } },
    ]));
    assert.deepEqual(Object.keys((await summaryFor("c")).metrics), []);
  });

  it("is null for a metric whose items recorded no peak", async () => {
    await splHistoryStore.upsert(record("d", [
      { "LCeq 1": { max: null, avg: null, leq: 88.1, count: 200 } },
    ]));
    const m = (await summaryFor("d")).metrics["LCeq 1"];
    assert.equal(m.max, null, "a peak nobody measured must not read as a number");
    assert.equal(m.leq, 88.1);
  });
});
