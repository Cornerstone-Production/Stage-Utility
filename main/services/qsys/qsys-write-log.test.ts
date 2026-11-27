// The write log when its file cannot be written: writes still record in memory,
// and the page is told so in a fixed phrase that names no path.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-write-log-"));
process.env.STAGE_UTILITY_DATA = TMP;
// A directory where the file should be: it cannot be read, so nothing may be saved over it.
await fs.mkdir(path.join(TMP, "qsys-write-log.json"));

const { qsysWriteLog, WRITE_LOG_SAVE_ERROR } = await import("./qsys-write-log.js");

after(async () => {
  await qsysWriteLog.whenIdle();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("a write log that cannot be saved keeps entries in memory and reports a fixed phrase, never the path", async () => {
  const lines: string[] = [];
  const quiet = [mock.method(console, "error", (...a: unknown[]) => void lines.push(a.map(String).join(" "))), mock.method(console, "warn", () => {})];
  try {
    await qsysWriteLog.add({ at: 1, panelId: null, device: "d", component: "c", control: "n", from: null, to: 1, result: "ok" });
    await qsysWriteLog.whenIdle();
  } finally {
    for (const m of quiet) m.mock.restore();
  }
  const { entries, saveError } = await qsysWriteLog.list();
  assert.equal(entries.length, 1);
  assert.equal(saveError, WRITE_LOG_SAVE_ERROR);
  assert.ok(!saveError!.includes(TMP), "the data directory reached the page");
  assert.ok(lines.some((l) => l.startsWith("[qsys] could not save the write log")), "the failure did not reach /log");
});
