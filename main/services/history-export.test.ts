// The .xlsx export and the .xlsx importer, tested against each other.
//
// These two are the only spreadsheet code in the app and they share a library,
// so a round trip is the honest test: build a workbook from seeded history, read
// the bytes back, and check the values survived. A column silently shifting out
// of step with its heading is the failure worth catching, so the assertions read
// cells by looking their heading up rather than by index.

import assert from "node:assert/strict";
import { test, describe, before } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import readXlsxFile from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-export-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { buildHistoryWorkbook } = await import("./history-export.js");
const { parseXlsx } = await import("./patch-xlsx.js");
const { attendanceStore } = await import("./attendance-store.js");
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { splHistoryStore } = await import("./spl-history-store.js");

const KEY = "st1:plan1:t1";

/** Read one sheet out of workbook bytes as { headers, rows-of-cells-by-heading }. */
async function sheetOf(buf: Buffer, name: string) {
  const sheets = await readXlsxFile(buf);
  const found = sheets.find((s) => s.sheet === name);
  assert.ok(found, `sheet ${name} missing — got ${sheets.map((s) => s.sheet).join(", ")}`);
  const [headerRow, ...rest] = found.data;
  const headers = headerRow.map((h) => String(h ?? ""));
  return {
    headers,
    rows: rest.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? null]))),
  };
}

before(async () => {
  await attendanceStore.upsert({
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan1",
    planTitle: "Sunday Plan",
    seriesTitle: "A Series",
    serviceDate: "2026-07-26",
    serviceTimeId: "t1",
    serviceTimeStartsAt: "2026-07-26T09:00:00.000Z",
    startedAt: "2026-07-26T08:45:00.000Z",
    endedAt: "2026-07-26T10:15:00.000Z",
    samples: [
      { t: "2026-07-26T08:50:00.000Z", attendance: 40, occupancy: 38, phase: "pre" },
      { t: "2026-07-26T09:30:00.000Z", attendance: 412, occupancy: 400 },
    ],
    attendanceBaseline: 0,
    totalAttendance: 512,
    peakAttendance: 412,
    peakOccupancy: 400,
    minOccupancy: 38,
    lastAttendance: 412,
    lastOccupancy: 400,
  });

  await serviceTimelineStore.upsert({
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan1",
    planTitle: "Sunday Plan",
    seriesTitle: "A Series",
    serviceDate: "2026-07-26",
    serviceTimeId: "t1",
    serviceTimeStartsAt: "2026-07-26T09:00:00.000Z",
    startedAt: "2026-07-26T09:00:00.000Z",
    endedAt: "2026-07-26T10:15:00.000Z",
    items: [
      {
        itemId: "i1",
        title: "Countdown",
        sequence: 1,
        plannedLengthSec: 300,
        startedAt: "2026-07-26T09:00:00.000Z",
        endedAt: "2026-07-26T09:06:00.000Z",
        actualDurationSec: 360,
        preService: true,
      },
      {
        itemId: "i2",
        title: "Welcome",
        sequence: 2,
        plannedLengthSec: null,
        startedAt: "2026-07-26T09:06:00.000Z",
        endedAt: null,
        actualDurationSec: null,
      },
    ],
  });

  await splHistoryStore.upsert({
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan1",
    planTitle: "Sunday Plan",
    seriesTitle: "A Series",
    serviceDate: "2026-07-26",
    serviceTimeId: "t1",
    serviceTimeStartsAt: "2026-07-26T09:00:00.000Z",
    meterId: "m1",
    metricKey: "LAeq",
    startedAt: "2026-07-26T09:00:00.000Z",
    endedAt: "2026-07-26T10:15:00.000Z",
    items: [
      {
        itemId: "i1",
        title: "Countdown",
        sequence: 1,
        metrics: { LAeq: { max: 92.5, avg: 88.1, count: 120 } },
        maxSpl: 92.5,
        avgSpl: 88.1,
        sampleCount: 120,
        startedAt: "2026-07-26T09:00:00.000Z",
        endedAt: "2026-07-26T09:06:00.000Z",
      },
      // No named metrics — must still produce a row, carrying the capture's key.
      {
        itemId: "i2",
        title: "Welcome",
        sequence: 2,
        metrics: {},
        maxSpl: 80,
        avgSpl: 76.25,
        sampleCount: 30,
        startedAt: "2026-07-26T09:06:00.000Z",
        endedAt: null,
      },
    ],
  });
});

describe("buildHistoryWorkbook", () => {
  test("writes a real .xlsx — a zip the reader can open", async () => {
    const buf = await buildHistoryWorkbook({ include: [] });
    assert.ok(Buffer.isBuffer(buf), "must return a Buffer for the HTTP response");
    assert.equal(buf.subarray(0, 2).toString(), "PK", "an .xlsx is a zip archive");
  });

  test("About is always present, so the file explains itself", async () => {
    const buf = await buildHistoryWorkbook({ include: [] });
    const sheets = await readXlsxFile(buf);
    assert.deepEqual(
      sheets.map((s) => s.sheet),
      ["About"],
    );
    const labels = sheets[0]!.data.map((r) => r[0]);
    assert.deepEqual(labels, ["Stage Utility", "Generated", "Date range", "Sheets", "Services in range"]);
  });

  test("only the requested sheets are written, in a stable order", async () => {
    const buf = await buildHistoryWorkbook({ include: ["spl", "services"] });
    const names = (await readXlsxFile(buf)).map((s) => s.sheet);
    assert.deepEqual(names, ["About", "Services", "SPL"]);
  });

  // Each sheet's full heading list is pinned. Values are asserted by heading, so
  // without this a dropped or reordered column would go unnoticed — every other
  // assertion would still find its own heading and pass.
  test("every sheet's columns are exactly as declared", async () => {
    const buf = await buildHistoryWorkbook({ include: ["services", "attendance", "items", "spl"] });
    assert.deepEqual((await sheetOf(buf, "Services")).headers, [
      "Date",
      "Scheduled",
      "Service type",
      "Plan",
      "Series",
      "Started",
      "Ended",
      "Duration (s)",
      "Items",
      "Peak attendance",
      "Peak in-room",
      "Lowest in-room",
      "Total attendance",
    ]);
    assert.deepEqual((await sheetOf(buf, "Attendance polls")).headers, [
      "Date",
      "Service type",
      "Service key",
      "Timestamp",
      "Attendance",
      "In-room",
      "Phase",
    ]);
    assert.deepEqual((await sheetOf(buf, "PCO items")).headers, [
      "Date",
      "Service type",
      "Service key",
      "#",
      "Item",
      "Planned (s)",
      "Actual (s)",
      "Delta (s)",
      "Pre-service",
      "Started",
      "Ended",
    ]);
    assert.deepEqual((await sheetOf(buf, "SPL")).headers, [
      "Date",
      "Service type",
      "Service key",
      "#",
      "Item",
      "Metric",
      "Max (dB)",
      "Avg (dB)",
      "Samples",
    ]);
  });

  test("a service row carries values under the right headings", async () => {
    const buf = await buildHistoryWorkbook({ include: ["services"] });
    const { rows } = await sheetOf(buf, "Services");
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r["Date"], "2026-07-26");
    assert.equal(r["Service type"], "Weekend");
    assert.equal(r["Plan"], "Sunday Plan");
    assert.equal(r["Series"], "A Series");
    assert.equal(r["Items"], 2);
    assert.equal(r["Peak attendance"], 412);
    assert.equal(r["Lowest in-room"], 38);
    assert.equal(r["Total attendance"], 512);
    // 09:00 → 10:15 is 75 minutes.
    assert.equal(r["Duration (s)"], 4500);
  });

  test("numbers stay numbers, so the sheet can be summed", async () => {
    const buf = await buildHistoryWorkbook({ include: ["services"] });
    const { rows } = await sheetOf(buf, "Services");
    assert.equal(typeof rows[0]!["Peak attendance"], "number");
    assert.equal(typeof rows[0]!["Duration (s)"], "number");
  });

  test("every attendance sample becomes a row, including the pre-service ramp", async () => {
    const buf = await buildHistoryWorkbook({ include: ["attendance"] });
    const { rows } = await sheetOf(buf, "Attendance polls");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!["Phase"], "pre");
    // An omitted phase means in-service; it must be labelled, not left blank.
    assert.equal(rows[1]!["Phase"], "in-service");
    assert.equal(rows[1]!["Attendance"], 412);
  });

  test("a still-live item exports with blanks rather than a bogus duration", async () => {
    const buf = await buildHistoryWorkbook({ include: ["items"] });
    const { rows } = await sheetOf(buf, "PCO items");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!["Delta (s)"], 60); // 360 actual − 300 planned
    assert.equal(rows[0]!["Pre-service"], "yes");
    const live = rows[1]!;
    assert.equal(live["Actual (s)"], null);
    assert.equal(live["Delta (s)"], null);
    assert.equal(live["Ended"], null);
    assert.equal(live["Pre-service"], null);
  });

  test("an item with no named metrics still exports, under the capture's key", async () => {
    const buf = await buildHistoryWorkbook({ include: ["spl"] });
    const { rows } = await sheetOf(buf, "SPL");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!["Metric"], "LAeq");
    assert.equal(rows[0]!["Max (dB)"], 92.5);
    assert.equal(rows[1]!["Metric"], "LAeq", "falls back to the capture's metricKey");
    assert.equal(rows[1]!["Samples"], 30);
  });

  test("the date range filters rows out", async () => {
    const buf = await buildHistoryWorkbook({ from: "2026-01-01", to: "2026-01-31", include: ["services"] });
    const { rows } = await sheetOf(buf, "Services");
    assert.equal(rows.length, 0);
  });
});

describe("parseXlsx", () => {
  /** Build a one-sheet .xlsx and hand it over the way an upload arrives. */
  async function upload(data: (string | number | null)[][]): Promise<string> {
    const buf = await writeXlsxFile(data.map((r) => r.map((v) => (v == null ? null : { value: v })))).toBuffer();
    return buf.toString("base64");
  }

  test("the first row becomes headers and the rest become rows", async () => {
    const { headers, rows } = await parseXlsx(
      await upload([
        ["Channel", "Name", "Device"],
        [1, "Kick", "SM91"],
        [2, "Snare", "SM57"],
      ]),
    );
    assert.deepEqual(headers, ["Channel", "Name", "Device"]);
    assert.deepEqual(rows, [
      ["1", "Kick", "SM91"],
      ["2", "Snare", "SM57"],
    ]);
  });

  // No test for heading whitespace: the writer normalises it away, so a fixture
  // built here can never carry padding into the reader. `parseXlsx` still trims,
  // for files Excel itself produced.

  test("blank rows are dropped rather than imported as empty patch rows", async () => {
    const { rows } = await parseXlsx(
      await upload([
        ["Channel", "Name"],
        [1, "Kick"],
        [null, null],
        [2, "Snare"],
      ]),
    );
    assert.deepEqual(rows, [
      ["1", "Kick"],
      ["2", "Snare"],
    ]);
  });

  test("an empty workbook yields nothing rather than throwing", async () => {
    const { headers, rows } = await parseXlsx(await upload([[]]));
    assert.deepEqual(headers, []);
    assert.deepEqual(rows, []);
  });

  test("the export can be read back by the importer", async () => {
    // The two halves share a library; this is the seam between them.
    const buf = await buildHistoryWorkbook({ include: ["services"] });
    const { headers } = await parseXlsx(buf.toString("base64"));
    assert.equal(headers[0], "Stage Utility", "reads the first sheet, which is About");
  });
});
