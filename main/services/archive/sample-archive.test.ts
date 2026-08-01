import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-svc-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { sampleArchive } = await import("./sample-archive.js");
const { parseRows } = await import("./csv.js");

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
  assert.deepEqual(r[0], ["at", "source", "kind", "detail"]);
  assert.deepEqual(r[1].slice(1), ["pco", "item", "Welcome"]);
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
