import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rebuild-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { sampleArchive } = await import("./sample-archive.js");
const { archivedSampleCount, rebuildSplItems, rebuildSplRecord } = await import("./rebuild.js");
const { addLeqSample } = await import("../spl-leq.js");

const CTX = { serviceKey: "st1:p1:t9", serviceDate: "2026-07-26" };

/** The same fold the live recorder does, as an independent reference. */
function expectedLeq(values: number[]): number {
  let leq: number | null = null;
  let count = 0;
  for (const v of values) {
    leq = addLeqSample(leq, count, v);
    count += 1;
  }
  return leq as number;
}

test("a rebuild reproduces the fold the live recorder computed", async () => {
  // Dynamic material — the case where an arithmetic mean of decibels goes wrong,
  // so a rebuild that silently used the wrong formula would show up here.
  const welcome = [88.2, 91.4, 79.0, 103.6, 85.1];
  const song = [95.0, 97.2, 99.9];
  for (const v of welcome) sampleArchive.recordSpl(CTX, "i1", "Welcome", { "SPL A Slow": v });
  for (const v of song) sampleArchive.recordSpl(CTX, "i2", "Song", { "SPL A Slow": v });
  await sampleArchive.flush();

  const items = await rebuildSplItems(CTX.serviceKey, CTX.serviceDate);
  assert.ok(items, "the service has an archive");
  assert.equal(items.length, 2);

  const [a, b] = items;
  assert.equal(a.itemId, "i1");
  assert.equal(a.title, "Welcome");
  assert.equal(a.metrics["SPL A Slow"].count, welcome.length);
  assert.equal(a.metrics["SPL A Slow"].max, 103.6);
  assert.ok(
    Math.abs((a.metrics["SPL A Slow"].leq as number) - expectedLeq(welcome)) < 1e-9,
    `${a.metrics["SPL A Slow"].leq} vs ${expectedLeq(welcome)}`,
  );

  assert.equal(b.itemId, "i2");
  assert.equal(b.metrics["SPL A Slow"].count, song.length);
  assert.equal(b.metrics["SPL A Slow"].max, 99.9);
  assert.ok(Math.abs((b.metrics["SPL A Slow"].leq as number) - expectedLeq(song)) < 1e-9);
});

test("energy averaging is not an arithmetic mean — the rebuild would fail if it were", () => {
  const values = [88.2, 91.4, 79.0, 103.6, 85.1];
  const arithmetic = values.reduce((s, v) => s + v, 0) / values.length;
  assert.ok(
    expectedLeq(values) - arithmetic > 3,
    "on dynamic material the energy average sits well above the arithmetic mean",
  );
});

test("item order and timestamps come back", async () => {
  const items = (await rebuildSplItems(CTX.serviceKey, CTX.serviceDate))!;
  assert.deepEqual(
    items.map((i) => i.sequence),
    [0, 1],
  );
  for (const it of items) {
    assert.ok(it.startedAt, "start stamped from the first sample");
    assert.ok(it.endedAt, "end stamped from the last");
    assert.ok(Date.parse(it.endedAt) >= Date.parse(it.startedAt));
  }
});

test("every metric is rebuilt, not just the primary one", async () => {
  const ctx = { serviceKey: "st1:p2:t1", serviceDate: "2026-07-26" };
  sampleArchive.recordSpl(ctx, "i1", "Song", { "SPL A Slow": 90, "LAeq 10": 85, "SPL C Fast": 99 });
  sampleArchive.recordSpl(ctx, "i1", "Song", { "SPL A Slow": 92, "LAeq 10": 86, "SPL C Fast": 101 });
  await sampleArchive.flush();

  const items = (await rebuildSplItems(ctx.serviceKey, ctx.serviceDate))!;
  assert.deepEqual(Object.keys(items[0].metrics).sort(), ["LAeq 10", "SPL A Slow", "SPL C Fast"]);
  assert.equal(items[0].metrics["SPL C Fast"].max, 101);
});

test("samples that rolled to a second file are included", async () => {
  const ctx = { serviceKey: "st1:p3:t1", serviceDate: "2026-07-26" };
  sampleArchive.recordSpl(ctx, "i1", "Song", { "SPL A Slow": 90 });
  await sampleArchive.flush();
  // A meter starting to report a new metric mid-service rolls the file.
  sampleArchive.recordSpl(ctx, "i1", "Song", { "SPL A Slow": 92, "LAeq 10": 80 });
  await sampleArchive.flush();

  const items = (await rebuildSplItems(ctx.serviceKey, ctx.serviceDate))!;
  assert.equal(items[0].metrics["SPL A Slow"].count, 2, "both files were read");
  assert.equal(items[0].metrics["LAeq 10"].count, 1);
});

test("a service with no archive rebuilds to null rather than an empty record", async () => {
  assert.equal(await rebuildSplItems("st1:never:t1", "2020-01-01"), null);
  assert.equal(await archivedSampleCount("st1:never:t1", "2020-01-01"), 0);
});

test("rebuilding a record keeps its identity and the fields samples cannot carry", async () => {
  const record = {
    serviceKey: CTX.serviceKey,
    serviceTypeId: "st1",
    serviceTypeName: "Sunday",
    planId: "p1",
    planTitle: "A Plan",
    seriesTitle: null,
    serviceDate: CTX.serviceDate,
    serviceTimeId: "t9",
    serviceTimeStartsAt: null,
    meterId: "m1",
    metricKey: "SPL A Slow",
    startedAt: "2026-07-26T09:00:00.000Z",
    endedAt: "2026-07-26T10:15:00.000Z",
    items: [
      { itemId: "i1", title: "Welcome", itemType: "song", sequence: 0, metrics: {}, maxSpl: null, avgSpl: null, sampleCount: 0, startedAt: "", endedAt: null },
    ],
  };
  const out = (await rebuildSplRecord(record as never))!;
  assert.equal(out.planTitle, "A Plan", "identity is not in the samples and is preserved");
  assert.equal(out.serviceTimeId, "t9");
  assert.equal(out.items[0].itemType, "song", "item type comes from the plan, carried from the prior record");
  assert.equal(out.items[0].maxSpl, 103.6, "primary-metric mirror repopulated");
  assert.equal(out.items[0].sampleCount, 5);
});
