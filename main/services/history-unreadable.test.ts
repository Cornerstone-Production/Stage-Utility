// A history record that is on disk and could not be read is not a service this
// box never recorded.
//
// The stores answer from what did read (keyed-record-store.ts). Everything that
// acts on the whole history, or rewrites one service, has to refuse instead:
// an import took a service whose only record would not parse for new and
// replaced that record and its raw files with the archive's; a merge re-keyed
// the source onto a target it took for empty, over the target's file; an export
// and the History workbook left the service out and read as complete; the
// per-service reads answered that it was never recorded.
//
// A record that will not parse is the unreadable case here, so the test does
// not depend on running as a user that file permissions apply to. The stores
// are singletons that keep an unread file until the process exits, which is
// why this has a file of its own.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { strToU8, zipSync } from "fflate";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-unread-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const DATE = "2026-10-18";
/** Recorded here, with its attendance record unreadable and nothing else. */
const TORN = "st1:p1:torn";
/** Recorded here and readable in all three stores. */
const OK = "st1:p1:ok";
const TORN_FILE = path.join(TMP, "attendance-history", "st1-p1-torn.json");
const TORN_RAW = path.join(TMP, "archive", `${DATE}_st1-p1-torn`, "attendance.csv");

function identity(serviceKey: string, startedAt: string) {
  return {
    serviceKey,
    serviceTypeId: "st1",
    serviceTypeName: "Sunday",
    planId: "p1",
    planTitle: "Sunday",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: serviceKey.split(":")[2],
    serviceTimeStartsAt: null,
    startedAt,
    endedAt: `${DATE}T16:00:00.000Z`,
  };
}

const attendance = (key: string, startedAt: string) =>
  ({ ...identity(key, startedAt), samples: [], peak: 400 }) as never;

// Written before any store is imported: each reads its directory once.
await fs.mkdir(path.dirname(TORN_FILE), { recursive: true });
await fs.writeFile(TORN_FILE, "{ torn");
await fs.mkdir(path.dirname(TORN_RAW), { recursive: true });
await fs.writeFile(TORN_RAW, "at,n\n2026-10-18T14:00:00.000Z,812\n");
await fs.writeFile(
  path.join(TMP, "attendance-history", "st1-p1-ok.json"),
  JSON.stringify(attendance(OK, `${DATE}T15:00:00.000Z`)),
);

const { attendanceStore } = await import("./attendance-store.js");
const { buildArchive, importArchive, inspectArchive } = await import("./archive/archive-bundle.js");
const { deleteServiceRecords, mergeServiceRecords } = await import("./history-edit.js");
const { buildHistoryWorkbook } = await import("./history-export.js");
const { StoreReadError } = await import("./data-store.js");
const { handlerErrorStatus } = await import("./remote-server.js");
const { historyRoutes } = await import("./routes/history-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

/** An archive holding the torn service, as if from another box. */
function archiveOfTorn(): Uint8Array {
  const dir = `${DATE}_st1-p1-torn`;
  const manifest = {
    kind: "stage-utility-archive",
    version: 1,
    appVersion: "0.0.0",
    createdAt: `${DATE}T20:00:00.000Z`,
    services: [{ serviceKey: TORN, serviceDate: DATE, dir }],
  };
  return zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "stores/attendance-history.json": strToU8(
      JSON.stringify({ services: { [TORN]: attendance(TORN, `${DATE}T14:00:00.000Z`) } }),
    ),
    [`archive/${dir}/attendance.csv`]: strToU8("at,n\n2026-10-18T14:45:00.000Z,5\n"),
  });
}

function isStoreReadError(err: unknown): boolean {
  assert.ok(err instanceof StoreReadError, `not a StoreReadError: ${String(err)}`);
  assert.equal(handlerErrorStatus(err), 503);
  assert.match(err.message, /st1-p1-torn\.json in attendance-history/);
  return true;
}

async function untouched(): Promise<void> {
  assert.equal(await fs.readFile(TORN_FILE, "utf8"), "{ torn", "the record it could not read was replaced");
  assert.equal(
    await fs.readFile(TORN_RAW, "utf8"),
    "at,n\n2026-10-18T14:00:00.000Z,812\n",
    "the raw rows this box recorded were replaced",
  );
}

describe("with a history record that could not be read", () => {
  it("an import refuses, rather than taking that service for new", async (t) => {
    captureConsole(t, "error"); // the store says so at its first load
    await assert.rejects(importArchive(archiveOfTorn(), { mode: "skip" }), isStoreReadError);
    await untouched();
  });

  it("a merge-mode import refuses too", async () => {
    await assert.rejects(importArchive(archiveOfTorn(), { mode: "merge" }), isStoreReadError);
    await untouched();
  });

  it("inspecting an import refuses rather than reporting the service as new", async () => {
    await assert.rejects(inspectArchive(archiveOfTorn()), isStoreReadError);
  });

  it("an export refuses rather than leaving the service out", async () => {
    await assert.rejects(buildArchive(), isStoreReadError);
  });

  it("a scheduled backup with the archive writes nothing, rather than a config copy per retry", async (t) => {
    captureConsole(t, "error");
    const { backupScheduler, DEFAULT_BACKUP_SCHEDULE } = await import("./backup-scheduler.js");
    const { settingsStore } = await import("./settings-store.js");
    await settingsStore.patch({ backupSchedule: { ...DEFAULT_BACKUP_SCHEDULE, enabled: true, includeArchive: true } });
    const dir = await backupScheduler.destinationDir();
    const before = await fs.readdir(dir).catch(() => [] as string[]);
    const result = await backupScheduler.runNow();
    assert.match(result.lastError ?? "", /st1-p1-torn\.json in attendance-history/);
    assert.deepEqual(await fs.readdir(dir).catch(() => [] as string[]), before, "a failed run left a file behind");
  });

  it("the History workbook refuses rather than reading as complete", async () => {
    await assert.rejects(buildHistoryWorkbook({ include: ["services"] }), isStoreReadError);
  });

  it("a merge into that service refuses, rather than re-keying onto it over the file", async () => {
    await assert.rejects(mergeServiceRecords(OK, TORN), isStoreReadError);
    await untouched();
    assert.ok(await attendanceStore.get(OK), "the source record went somewhere");
  });

  it("deleting that service refuses", async () => {
    await assert.rejects(deleteServiceRecords(TORN), isStoreReadError);
    await untouched();
  });

  it("reading that service's record fails, rather than answering it was never recorded", async () => {
    await assert.rejects(callRoute(historyRoutes, `/api/attendance/history/${encodeURIComponent(TORN)}`), isStoreReadError);
    const other = await callRoute(historyRoutes, `/api/attendance/history/${encodeURIComponent("st1:p1:never")}`);
    assert.equal(other.status, 200, "a key with no file at all still answers");
  });

  it("a service whose records all read can still be edited", async () => {
    assert.deepEqual(await deleteServiceRecords(OK), { deleted: true, records: ["attendance"] });
  });

  it("a recorder's save for that service is held beside the file, not refused", async (t) => {
    captureConsole(t, "error");
    await attendanceStore.upsert(attendance(TORN, `${DATE}T14:50:00.000Z`));
    await untouched();
    const held = (await fs.readdir(path.dirname(TORN_FILE))).filter((n) => n.startsWith("st1-p1-torn.json.held-"));
    assert.equal(held.length, 1, held.join());
  });
});
