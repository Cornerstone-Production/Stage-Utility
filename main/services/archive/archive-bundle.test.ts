import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { strToU8, unzipSync, zipSync } from "fflate";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-bundle-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { ARCHIVE_KIND, buildArchive, importArchive, inspectArchive } = await import("./archive-bundle.js");
const { splHistoryStore } = await import("../spl-history-store.js");
const { parseRows: parseRowsForTest } = await import("../csv.js");

function record(serviceKey: string, serviceDate: string, planTitle = "Plan") {
  return {
    serviceKey,
    serviceTypeId: "st1",
    serviceTypeName: "Sunday",
    planId: "p1",
    planTitle,
    seriesTitle: null,
    serviceDate,
    serviceTimeId: "t9",
    serviceTimeStartsAt: null,
    meterId: null,
    metricKey: null,
    startedAt: `${serviceDate}T09:00:00.000Z`,
    endedAt: `${serviceDate}T10:15:00.000Z`,
    items: [],
  } as never;
}

async function writeRaw(dir: string, body: string): Promise<string> {
  const full = path.join(dataDir, "archive", dir);
  await fs.mkdir(full, { recursive: true });
  await fs.writeFile(path.join(full, "spl.csv"), body);
  return full;
}

test("bundles the raw files and the derived records", async () => {
  await splHistoryStore.upsert(record("st1:p1:t9", "2026-07-26"));
  await writeRaw("2026-07-26_st1-p1-t9", "at,db\n2026-07-26T09:00:00.000Z,90\n");

  const files = unzipSync(await buildArchive());
  const names = Object.keys(files);
  assert.ok(names.includes("manifest.json"), names.join());
  assert.ok(names.includes("archive/2026-07-26_st1-p1-t9/spl.csv"), names.join());
  assert.ok(names.includes("stores/spl-history.json"), names.join());

  const m = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  assert.equal(m.kind, ARCHIVE_KIND);
  assert.equal(m.version, 1);
  assert.deepEqual(
    m.services.map((s: { serviceKey: string }) => s.serviceKey),
    ["st1:p1:t9"],
  );
  assert.equal(m.services[0].dir, "2026-07-26_st1-p1-t9");
});

test("inspect reports which services are new and which are already here", async () => {
  const zip = await buildArchive();
  const plan = await inspectArchive(zip);
  assert.equal(plan.identicalServices.length, 1, "this box produced it, byte for byte");
  assert.equal(plan.differingServices.length, 0);
  assert.equal(plan.newServices.length, 0);

  await splHistoryStore.delete("st1:p1:t9");
  const after = await inspectArchive(zip);
  assert.equal(after.newServices.length, 1);
  assert.equal(after.identicalServices.length, 0);
});

test("a service already here with matching content is identical, not merely present", async () => {
  await splHistoryStore.upsert(record("st1:pSame:t1", "2026-09-06"));
  const zip = await buildArchive();
  const plan = await inspectArchive(zip);
  assert.ok(
    plan.identicalServices.some((s) => s.serviceKey === "st1:pSame:t1"),
    JSON.stringify(plan.identicalServices),
  );
  assert.ok(!plan.differingServices.some((s) => s.serviceKey === "st1:pSame:t1"));
});

test("a service whose local copy has since changed is reported as differing", async () => {
  await splHistoryStore.upsert(record("st1:pDiff:t1", "2026-09-13"));
  const zip = await buildArchive();
  await splHistoryStore.upsert(record("st1:pDiff:t1", "2026-09-13", "edited since the archive"));

  const plan = await inspectArchive(zip);
  assert.ok(
    plan.differingServices.some((s) => s.serviceKey === "st1:pDiff:t1"),
    JSON.stringify(plan.differingServices),
  );
  assert.ok(!plan.identicalServices.some((s) => s.serviceKey === "st1:pDiff:t1"));
});

test("field order alone never counts as a difference", async () => {
  // Same data, keys emitted in a different order — a record round-tripped through
  // another tool would otherwise read as changed and prompt a pointless decision.
  const forward = record("st1:pOrder:t1", "2026-09-20") as unknown as Record<string, unknown>;
  const reversed = Object.fromEntries(Object.entries(forward).reverse());
  await splHistoryStore.upsert(forward as never);
  const zip = await buildArchive();
  await splHistoryStore.upsert(reversed as never);

  const plan = await inspectArchive(zip);
  assert.ok(
    plan.identicalServices.some((s) => s.serviceKey === "st1:pOrder:t1"),
    JSON.stringify(plan.differingServices),
  );
});

test("a config snapshot is rejected by name, not read as an empty archive", async () => {
  const snapshot = zipSync({
    "manifest.json": strToU8(JSON.stringify({ kind: "stage-utility-config", version: 1, files: {} })),
  });
  await assert.rejects(() => inspectArchive(snapshot), /not a Stage Utility data archive/i);
});

test("a newer schema version is refused with the version in the message", async () => {
  const future = zipSync({
    "manifest.json": strToU8(JSON.stringify({ kind: ARCHIVE_KIND, version: 99, services: [] })),
  });
  await assert.rejects(() => inspectArchive(future), /version 99/);
});

test("a zip with no manifest is refused", async () => {
  await assert.rejects(() => inspectArchive(zipSync({ "spl.csv": strToU8("at,db\n") })), /no manifest/i);
});

test("something that is not a zip at all is refused", async () => {
  await assert.rejects(() => inspectArchive(strToU8("just some text")), /not a readable zip/i);
});

test("the config snapshot json — the realistic mistake — is named, not called an unreadable zip", async () => {
  // The real file: plain JSON, so it never reaches the manifest kind check.
  const snapshot = strToU8(
    JSON.stringify({ kind: "stage-utility-config", version: 1, appVersion: "1.6.0", files: { "views.json": {} } }),
  );
  await assert.rejects(() => inspectArchive(snapshot), /config snapshot.*Backup & restore/is);
});

test("importing a service this box does not have adds it, raw files and all", async () => {
  await splHistoryStore.upsert(record("st1:pX:t1", "2026-08-02"));
  const dir = await writeRaw("2026-08-02_st1-pX-t1", "at,db\n2026-08-02T09:00:00.000Z,88\n");
  const zip = await buildArchive();

  await splHistoryStore.delete("st1:pX:t1");
  await fs.rm(dir, { recursive: true, force: true });

  const res = await importArchive(zip);
  assert.ok(res.added.includes("st1:pX:t1"), JSON.stringify(res));
  assert.ok(await splHistoryStore.get("st1:pX:t1"), "derived record restored");
  assert.equal(await fs.readFile(path.join(dir, "spl.csv"), "utf8"), "at,db\n2026-08-02T09:00:00.000Z,88\n");
});

test("importing the same archive twice is a no-op the second time", async () => {
  const zip = await buildArchive();
  const first = await importArchive(zip);
  const second = await importArchive(zip);
  assert.equal(second.added.length, 0, JSON.stringify(second));
  assert.equal(second.replaced.length, 0);
  assert.deepEqual(second.skipped.sort(), [...first.added, ...first.skipped].sort());
});

test("a service already present is skipped, not overwritten", async () => {
  await splHistoryStore.upsert(record("st1:pY:t1", "2026-08-09"));
  const zip = await buildArchive();
  await splHistoryStore.upsert(record("st1:pY:t1", "2026-08-09", "MINE - do not clobber"));

  const res = await importArchive(zip);
  assert.ok(res.skipped.includes("st1:pY:t1"), JSON.stringify(res));
  assert.equal((await splHistoryStore.get("st1:pY:t1"))!.planTitle, "MINE - do not clobber");
});

test("replace is explicit and only touches the named service", async () => {
  const zip = await buildArchive();
  await splHistoryStore.upsert(record("st1:pY:t1", "2026-08-09", "MINE"));
  await splHistoryStore.upsert(record("st1:pX:t1", "2026-08-02", "ALSO MINE"));

  const res = await importArchive(zip, { replace: ["st1:pY:t1"] });
  assert.deepEqual(res.replaced, ["st1:pY:t1"]);
  assert.equal((await splHistoryStore.get("st1:pY:t1"))!.planTitle, "MINE - do not clobber");
  assert.equal((await splHistoryStore.get("st1:pX:t1"))!.planTitle, "ALSO MINE", "untouched");
});

test("a corrupt member aborts the whole import with nothing written", async () => {
  const before = JSON.stringify(await splHistoryStore.list());
  const bad = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        kind: ARCHIVE_KIND,
        version: 1,
        appVersion: "0",
        createdAt: "2026-08-09T00:00:00.000Z",
        services: [{ serviceKey: "st1:pZ:t1", serviceDate: "2026-08-16", dir: null }],
      }),
    ),
    "stores/spl-history.json": strToU8("{ this is not json"),
  });

  await assert.rejects(() => importArchive(bad), /unreadable/i);
  assert.equal(JSON.stringify(await splHistoryStore.list()), before, "nothing was written");
});

test("a service with no raw files still imports its derived record", async () => {
  const zip = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        kind: ARCHIVE_KIND,
        version: 1,
        appVersion: "0",
        createdAt: "2026-08-09T00:00:00.000Z",
        services: [{ serviceKey: "st1:pOld:t1", serviceDate: "2025-01-05", dir: null }],
      }),
    ),
    "stores/spl-history.json": strToU8(
      JSON.stringify({ services: { "st1:pOld:t1": record("st1:pOld:t1", "2025-01-05") } }),
    ),
  });
  const res = await importArchive(zip);
  assert.ok(res.added.includes("st1:pOld:t1"), JSON.stringify(res));
  assert.ok(await splHistoryStore.get("st1:pOld:t1"));
});

test("merge fills the gap without touching what this box already recorded", async () => {
  // A box that recorded only the second half; the archive has the first half.
  const full = {
    ...(record("st1:pMerge:t1", "2026-10-04") as unknown as Record<string, unknown>),
    items: [
      { itemId: "i1", title: "Welcome", sequence: 0, metrics: {}, maxSpl: 80, sampleCount: 1 },
      { itemId: "i2", title: "Song", sequence: 1, metrics: {}, maxSpl: 95, sampleCount: 1 },
    ],
  };
  await splHistoryStore.upsert(full as never);
  const dir = await writeRaw("2026-10-04_st1-pMerge-t1", "at,db\n09:00,80\n09:05,95\n");
  const zip = await buildArchive();

  // Now this box only has the second item, with its own figure, and only the later row.
  await splHistoryStore.upsert({
    ...full,
    items: [{ itemId: "i2", title: "Song", sequence: 1, metrics: {}, maxSpl: 91, sampleCount: 1 }],
  } as never);
  await fs.writeFile(path.join(dir, "spl.csv"), "at,db\n09:05,91\n");

  const res = await importArchive(zip, { merge: ["st1:pMerge:t1"] });
  assert.deepEqual(res.merged, ["st1:pMerge:t1"]);
  assert.equal(res.replaced.length, 0);

  const after = (await splHistoryStore.get("st1:pMerge:t1"))! as unknown as {
    items: { itemId: string; maxSpl: number }[];
  };
  assert.deepEqual(after.items.map((i) => i.itemId), ["i1", "i2"], "missing item filled in");
  assert.equal(after.items[1].maxSpl, 91, "the item this box recorded is untouched");

  const csv = await fs.readFile(path.join(dir, "spl.csv"), "utf8");
  assert.deepEqual(parseRowsForTest(csv), [
    ["at", "db"],
    ["09:00", "80"],
    ["09:05", "91"],
  ]);
});

test("merge is idempotent end to end", async () => {
  const zip = await buildArchive();
  const once = await importArchive(zip, { merge: ["st1:pMerge:t1"] });
  const before = JSON.stringify(await splHistoryStore.get("st1:pMerge:t1"));
  const twice = await importArchive(zip, { merge: ["st1:pMerge:t1"] });
  assert.deepEqual(twice.merged, once.merged);
  assert.equal(JSON.stringify(await splHistoryStore.get("st1:pMerge:t1")), before);
});

test("replace wins over merge when a key is somehow in both lists", async () => {
  const res = await importArchive(await buildArchive(), {
    merge: ["st1:pMerge:t1"],
    replace: ["st1:pMerge:t1"],
  });
  assert.deepEqual(res.replaced, ["st1:pMerge:t1"]);
  assert.equal(res.merged.length, 0);
});

test("mode applies to every service already here, with no per-key list", async () => {
  await splHistoryStore.upsert(record("st1:pBulkA:t1", "2026-11-01"));
  await splHistoryStore.upsert(record("st1:pBulkB:t1", "2026-11-08"));
  const zip = await buildArchive();
  await splHistoryStore.upsert(record("st1:pBulkA:t1", "2026-11-01", "edited A"));
  await splHistoryStore.upsert(record("st1:pBulkB:t1", "2026-11-08", "edited B"));

  const res = await importArchive(zip, { mode: "replace" });
  assert.ok(res.replaced.includes("st1:pBulkA:t1"), JSON.stringify(res.replaced));
  assert.ok(res.replaced.includes("st1:pBulkB:t1"));
  assert.ok(!res.skipped.includes("st1:pBulkA:t1"), "a differing service is not skipped under mode replace");
  assert.ok(!res.skipped.includes("st1:pBulkB:t1"));
  assert.equal((await splHistoryStore.get("st1:pBulkA:t1"))!.planTitle, "Plan");
  assert.equal((await splHistoryStore.get("st1:pBulkB:t1"))!.planTitle, "Plan");
});

test("the default mode is skip — an import with no choice changes nothing", async () => {
  await splHistoryStore.upsert(record("st1:pBulkA:t1", "2026-11-01", "mine again"));
  const res = await importArchive(await buildArchive());
  assert.equal(res.replaced.length, 0);
  assert.equal(res.merged.length, 0);
  assert.equal((await splHistoryStore.get("st1:pBulkA:t1"))!.planTitle, "mine again");
});

test("an explicit key still overrides the mode for that one service", async () => {
  await splHistoryStore.upsert(record("st1:pBulkA:t1", "2026-11-01"));
  await splHistoryStore.upsert(record("st1:pBulkB:t1", "2026-11-08"));
  const zip = await buildArchive();
  await splHistoryStore.upsert(record("st1:pBulkA:t1", "2026-11-01", "keep me"));
  await splHistoryStore.upsert(record("st1:pBulkB:t1", "2026-11-08", "swap me"));

  const res = await importArchive(zip, { mode: "merge", replace: ["st1:pBulkB:t1"] });
  assert.ok(res.replaced.includes("st1:pBulkB:t1"), JSON.stringify(res));
  assert.ok(res.merged.includes("st1:pBulkA:t1"));
  assert.equal((await splHistoryStore.get("st1:pBulkA:t1"))!.planTitle, "keep me", "merge kept the local title");
  assert.equal((await splHistoryStore.get("st1:pBulkB:t1"))!.planTitle, "Plan", "replace took the archive's");
});

test("mode does not touch services that are already identical", async () => {
  // The readout promises a count of DIFFERING services; the result has to match it,
  // or "50 differ" comes back as "merged 56" and the operator was told the wrong thing.
  await splHistoryStore.upsert(record("st1:pSameAsArchive:t1", "2026-12-06"));
  const zip = await buildArchive();
  const plan = await inspectArchive(zip);
  const res = await importArchive(zip, { mode: "merge" });

  assert.ok(res.skipped.includes("st1:pSameAsArchive:t1"), "identical service left alone");
  assert.ok(!res.merged.includes("st1:pSameAsArchive:t1"));
  assert.equal(
    res.merged.length + res.replaced.length,
    plan.differingServices.length,
    "exactly the services the readout said would change",
  );
});
