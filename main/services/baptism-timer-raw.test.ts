// baptism-timer-raw.test.ts — every baptism timer action lands in the raw
// layer, including the LAST person in a grouped session.
//
// The task-6 brief's emit table said to place "person-complete" immediately
// before each `return this.commit()`. But next()'s grouped-baptism branch does
// NOT commit for the last person — it delegates to finalize() instead, which
// resets the whole session (phase, armed, pendingTestimonyMs) before its own
// commit(). Followed literally, the row for the LAST person is never written,
// and a replay reconstructs them with baptizeMs: 0 on every session that runs
// to its natural end (the ordinary case — a producer very rarely hits "finish"
// early). This file drives that exact path: start, two testimonies, arm, and
// baptize both people back to back with no manual "finish" press, and proves
// the last person's row survives with their real baptizeMs.
//
// Also covers: the raw layer never throws back into the timer (a full disk or
// a store outage must not take a live baptism down), and the "no service
// open" warning logs once per session rather than once per press.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-raw-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("./baptism-timer-service.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { sampleArchive } = await import("./archive/sample-archive.js");
const { parseRows } = await import("./csv.js");

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };
const rec = () => serviceTimelineRecorder as unknown as Held;

const CTX = { serviceKey: "st1:plan1:11am", serviceDate: "2026-09-20" };

function archiveDir(): string {
  return path.join(TMP, "archive", `${CTX.serviceDate}_${CTX.serviceKey.replace(/:/g, "-")}`);
}

async function baptismRows(): Promise<string[][]> {
  await sampleArchive.flush();
  return parseRows(await fs.readFile(path.join(archiveDir(), "baptism.csv"), "utf8"));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the raw layer records the last grouped person, not just phase 0..n-1", () => {
  beforeEach(() => {
    rec().current = { ...CTX, endedAt: null };
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
  });

  it("keeps the last person's baptism time when the session auto-finishes", async () => {
    baptismTimerService.start(); // testimony, person 1
    await sleep(5);
    baptismTimerService.next(); // person 1 testimony done, person 2 testimony starts
    await sleep(5);
    baptismTimerService.startBaptisms(); // person 2 testimony finalized, section armed
    baptismTimerService.advance(); // "first person in" — starts person 1's baptism clock
    await sleep(5);
    baptismTimerService.next(); // person 1 baptized, person 2's baptism clock starts
    await sleep(5);
    const finished = baptismTimerService.next(); // person 2 (LAST) baptized — auto-finishes

    assert.equal(finished.phase, "idle", "the session closed itself after the last person");
    assert.equal(finished.people.length, 2);
    const lastBaptizeMs = finished.people[1]!.baptizeMs;
    assert.ok(lastBaptizeMs > 0, "the last person's baptism actually ran a clock");

    const rows = await baptismRows();
    const header = rows[0]!;
    const eventCol = header.indexOf("event");
    const baptismIndexCol = header.indexOf("baptismIndex");
    const segmentCol = header.indexOf("segmentMs");

    const personCompleteRows = rows.slice(1).filter((r) => r[eventCol] === "person-complete");
    assert.equal(personCompleteRows.length, 2, "one person-complete row per person, including the last");

    const lastRow = personCompleteRows.find((r) => r[baptismIndexCol] === "1");
    assert.ok(lastRow, "the last person (baptismIndex 1) has its own person-complete row");
    assert.equal(
      Number(lastRow![segmentCol]),
      Math.round(lastBaptizeMs),
      "the row carries the same baptizeMs the finished session recorded — not 0",
    );

    // reset (in beforeEach), start, testimony-end (person 1), baptisms-armed
    // (person 2's testimony folded into arming), baptisms-start,
    // person-complete x2, finish — one row per operator action, not more, not
    // fewer.
    assert.equal(rows.length - 1, 8, "one raw row per action across the whole session");
  });
});

describe("the raw emit never throws back into the timer", () => {
  beforeEach(() => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
  });

  it("survives the archive throwing on write", () => {
    rec().current = { ...CTX, endedAt: null };
    const original = sampleArchive.recordBaptism;
    (sampleArchive as unknown as { recordBaptism: typeof sampleArchive.recordBaptism }).recordBaptism = () => {
      throw new Error("disk full");
    };
    try {
      const s = baptismTimerService.start();
      assert.equal(s.phase, "testimony", "the timer's own state still advanced despite the archive throwing");
    } finally {
      (sampleArchive as unknown as { recordBaptism: typeof sampleArchive.recordBaptism }).recordBaptism = original;
    }
  });
});

describe("the no-service warning logs once per session, not once per press", () => {
  beforeEach(() => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
  });

  it("warns once across several actions with no service open", async () => {
    rec().current = null; // no open service for the whole session
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[baptism] raw:")) warnings.push(args);
    };
    try {
      baptismTimerService.start();
      await sleep(2);
      baptismTimerService.next();
      baptismTimerService.pause();
      baptismTimerService.resume();
      assert.equal(warnings.length, 1, "one warning for the whole session, not one per press");
    } finally {
      console.warn = original;
    }

    // A NEW session gets its own warning — the latch is per-session, not global.
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    const warnings2: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[baptism] raw:")) warnings2.push(args);
    };
    try {
      baptismTimerService.start();
      baptismTimerService.pause();
      assert.equal(warnings2.length, 1, "a fresh session re-arms its own one-time warning");
    } finally {
      console.warn = original;
    }
  });
});
