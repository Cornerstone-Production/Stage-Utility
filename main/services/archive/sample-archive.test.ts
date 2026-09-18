import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-svc-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { sampleArchive } = await import("./sample-archive.js");
const { parseRows } = await import("../csv.js");
const { readArchiveRows } = await import("./archive-rows.js");

const CTX = { serviceKey: "st1:p1:t9", serviceDate: "2026-07-26" };

function dirFor(ctx: { serviceKey: string; serviceDate: string }): string {
  return path.join(dataDir, "archive", `${ctx.serviceDate}_${ctx.serviceKey.replace(/:/g, "-")}`);
}

async function rows(ctx: typeof CTX, name: string): Promise<string[][]> {
  return parseRows(await fs.readFile(path.join(dirFor(ctx), name), "utf8"));
}

test("writes one wide SPL row per tick", async () => {
  sampleArchive.recordSpl(CTX, "i1", "Welcome", { "SPL A Slow": 88.2, "LAeq 10": 85.1 });
  sampleArchive.recordSpl(CTX, "i1", "Welcome", { "SPL A Slow": 89.0, "LAeq 10": 85.4 });
  await sampleArchive.flush();

  const r = await rows(CTX, "spl.csv");
  assert.deepEqual(r[0], ["at", "itemId", "item", "LAeq 10", "SPL A Slow"]);
  assert.equal(r.length, 3, "header + 2 ticks");
  assert.equal(r[1][1], "i1");
  assert.equal(r[1][2], "Welcome");
  assert.equal(r[1][4], "88.2");
  assert.equal(r[2][4], "89");
});

test("metric columns are stable regardless of key order", async () => {
  sampleArchive.recordSpl(CTX, "i2", "Song", { "LAeq 10": 90, "SPL A Slow": 95 });
  await sampleArchive.flush();
  const r = await rows(CTX, "spl.csv");
  assert.equal(r[0].length, 5, "no new file was rolled");
  assert.equal(r.length, 4);
  assert.equal(r[3][3], "90");
  assert.equal(r[3][4], "95");
});

test("events land in their own file", async () => {
  sampleArchive.recordEvent(CTX, "pco", "item", "Welcome");
  await sampleArchive.flush();
  const r = await rows(CTX, "events.csv");
  assert.deepEqual(r[0], ["at", "source", "kind", "detail", "itemId", "plannedLengthSec", "preService"]);
  assert.deepEqual(r[1].slice(1), ["pco", "item", "Welcome", "", "", ""]);
});

// A timeline record is rebuilt from these rows, and a title is not an identity.
// Without the id column the rebuild can only match on the title, which is the
// fallback path, not the intended one.
test("a plan-item event row carries the item id, planned length and pre-service flag", async () => {
  const ctx = { serviceKey: "st1:p9:t1", serviceDate: "2026-07-26" };
  sampleArchive.recordEvent(ctx, "pco", "item", "Welcome", {
    itemId: "item-77",
    plannedLengthSec: 300,
    preService: true,
  });
  await sampleArchive.flush();
  const r = await rows(ctx, "events.csv");
  assert.deepEqual(r[0], ["at", "source", "kind", "detail", "itemId", "plannedLengthSec", "preService"]);
  assert.deepEqual(r[1].slice(1), ["pco", "item", "Welcome", "item-77", "300", "true"]);
});

// One header for every event source. An automation row writing a narrower
// header would roll the file on each alternation, and readArchiveRows
// concatenates rolled files in FILE order — so a rebuild would walk the rows
// out of time order.
test("an automation event shares the item row's columns and does not roll the file", async () => {
  const ctx = { serviceKey: "st1:p10:t1", serviceDate: "2026-07-26" };
  sampleArchive.recordEvent(ctx, "pco", "item", "Welcome", {
    itemId: "item-1",
    plannedLengthSec: null,
    preService: false,
  });
  sampleArchive.recordEvent(ctx, "automation", "fired", "House lights: ok");
  sampleArchive.recordEvent(ctx, "pco", "item", "Song", {
    itemId: "item-2",
    plannedLengthSec: 240,
    preService: false,
  });
  await sampleArchive.flush();
  const dir = dirFor(ctx);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((n) => n.startsWith("events")).sort(),
    ["events.csv"],
    "the event file rolled",
  );
  const r = await rows(ctx, "events.csv");
  assert.equal(r.length, 4, "header + three rows in one file");
  assert.deepEqual(r[2].slice(1), ["automation", "fired", "House lights: ok", "", "", ""]);
  assert.deepEqual(r[3].slice(1), ["pco", "item", "Song", "item-2", "240", "false"]);
});

test("attendance lands in its own file", async () => {
  sampleArchive.recordAttendance(CTX, { inside: 1100, entries: 1240, exits: 140 });
  await sampleArchive.flush();
  const r = await rows(CTX, "attendance.csv");
  assert.deepEqual(r[0], ["at", "entries", "exits", "inside"]);
  assert.deepEqual(r[1].slice(1), ["1240", "140", "1100"]);
});

test("attendance columns stay stable when a field is momentarily null", async () => {
  const ctx = { serviceKey: "st1:p2:t1", serviceDate: "2026-07-26" };
  sampleArchive.recordAttendance(ctx, { inside: 10, entries: 12, exits: 2 });
  sampleArchive.recordAttendance(ctx, { inside: null, entries: 13, exits: 3 });
  await sampleArchive.flush();
  const r = await rows(ctx, "attendance.csv");
  assert.equal(r.length, 3, "one file, not rolled");
  assert.deepEqual(r[2].slice(1), ["13", "3", ""]);
});

test("writes a manifest naming every file", async () => {
  await sampleArchive.writeManifest(CTX);
  const m = JSON.parse(await fs.readFile(path.join(dirFor(CTX), "manifest.json"), "utf8"));
  assert.equal(m.serviceKey, CTX.serviceKey);
  assert.equal(m.serviceDate, CTX.serviceDate);
  assert.equal(m.version, 1);
  assert.ok(m.files.includes("spl.csv"), JSON.stringify(m.files));
  assert.ok(m.files.includes("events.csv"));
  assert.ok(m.files.includes("attendance.csv"));
});

test("an empty serviceKey writes nothing at all", async () => {
  const before = (await fs.readdir(path.join(dataDir, "archive"))).sort();
  const none = { serviceKey: "", serviceDate: "2026-07-26" };
  sampleArchive.recordSpl(none, "i1", "x", { a: 1 });
  sampleArchive.recordAttendance(none, { inside: 1 });
  sampleArchive.recordEvent(none, "pco", "item", "x");
  await sampleArchive.writeManifest(none);
  await sampleArchive.flush();
  assert.deepEqual((await fs.readdir(path.join(dataDir, "archive"))).sort(), before);
});

// A service that started before the id/length columns shipped keeps its narrow
// `events.csv`; the appender rolls to `events.2.csv` for the wider set. Both
// have to read back, with the old rows simply absent in the new columns — the
// rebuild's title-only fallback depends on getting them at all.
test("an events file written before the new columns still reads back beside one written after", async () => {
  const ctx = { serviceKey: "st1:p11:t1", serviceDate: "2026-07-26" };
  const dir = dirFor(ctx);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "events.csv"),
    "at,source,kind,detail\n2026-07-26T10:00:00.000Z,pco,item,Doors\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "events.2.csv"),
    "at,source,kind,detail,itemId,plannedLengthSec,preService\n" +
      "2026-07-26T10:05:00.000Z,pco,item,Welcome,item-3,300,false\n",
    "utf8",
  );

  const read = await readArchiveRows(dir, "events");
  assert.ok(read, "the events source read back as absent");
  assert.equal(read.length, 2);
  assert.equal(read[0].detail, "Doors");
  assert.equal(read[0].itemId, undefined, "an old row has no itemId key at all");
  assert.equal(read[1].itemId, "item-3");
  assert.equal(read[1].plannedLengthSec, "300");
  assert.equal(read[1].preService, "false");
});

test("closeService releases the appenders so a later tick reopens cleanly", async () => {
  const ctx = { serviceKey: "st1:p3:t1", serviceDate: "2026-07-26" };
  sampleArchive.recordEvent(ctx, "pco", "item", "one");
  await sampleArchive.flush();
  sampleArchive.closeService(ctx.serviceKey);
  sampleArchive.recordEvent(ctx, "pco", "item", "two");
  await sampleArchive.flush();
  const r = await rows(ctx, "events.csv");
  assert.equal(r.length, 3, "header written once across the close");
  assert.equal(r[2][3], "two");
});
