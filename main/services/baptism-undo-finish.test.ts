// baptism-undo-finish.test.ts — Undo after Finish reopens the session where
// Finish was pressed.
//
// The finished-session undo branches assumed where that was. Grouped reopened
// the LAST person's baptism, right only for "Last person out": Finish pressed
// while baptizing person 1 of 3 came back on person 3 with person 2 skipped;
// Finish pressed while armed came back baptizing person 2 with person 1 skipped
// and a clock running nobody started; Finish pressed during the testimonies came
// back mid-baptism. Per-person reopened a baptism, so a Finish pressed during a
// testimony came back with that testimony frozen and a baptism clock running
// over the rest of it.
//
// Driven through the REAL timer. The raw rows these undos write, and what the
// replay and the lane make of them, are held to the store by the two round-trip
// suites in archive/, over the same session shapes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-undo-finish-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import type { BaptismState } from "../types/stage.js";

const { baptismTimerService: timer } = await import("./baptism-timer-service.js");
const { baptismStore } = await import("./baptism-store.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const baptized = (s: BaptismState) => s.people.map((p) => p.baptizeMs);

function begin(mode: "grouped" | "per-person"): void {
  timer.reset();
  timer.setMode(mode);
}

describe("grouped: Undo after Finish reopens the baptism Finish closed", () => {
  it("Finish while baptizing person 1 of 3: Undo comes back to person 1, not person 3", async () => {
    begin("grouped");
    timer.start();
    timer.next();
    timer.next();
    timer.startBaptisms(); // three people, armed
    timer.advance(); // person 1 steps in
    await sleep(20);
    const finished = timer.finish();
    assert.ok(finished.people[0]!.baptizeMs > 0, "sanity: person 1's baptism ran and was closed by Finish");

    const back = timer.undo();
    assert.equal(back.phase, "baptism");
    assert.equal(back.baptismIndex, 0, "the person Finish closed, not the last person");
    assert.equal(back.armed ?? false, false);
    assert.notEqual(back.segmentStartedAt, null, "person 1's clock runs again");
    assert.deepEqual(baptized(back), [0, 0, 0], "person 1 is re-timed from zero; persons 2 and 3 were never baptized");
    assert.equal(back.finishedFrom ?? null, null, "a reopened session carries no finish to undo");
  });

  it("Finish while armed: Undo goes back to waiting for the first person, with no clock running", () => {
    begin("grouped");
    timer.start();
    timer.next();
    timer.startBaptisms(); // two people, armed
    timer.finish();

    const back = timer.undo();
    assert.equal(back.phase, "baptism");
    assert.equal(back.armed, true, "nobody had stepped in, so it is armed again");
    assert.equal(back.baptismIndex, 0, "person 1 is next in, not person 2");
    assert.equal(back.segmentStartedAt, null, "no clock: a clock here would baptize person 1 from the Undo press");
    assert.equal(back.segmentAccumMs ?? 0, 0);
    assert.deepEqual(baptized(back), [0, 0]);
    assert.equal(back.finishedAt, null);
    assert.equal(back.finishedFrom ?? null, null);

    const first = timer.advance(); // the first press, as the panel sends it
    assert.equal(first.baptismIndex, 0, "the first person in is person 1");
    assert.notEqual(first.segmentStartedAt, null);
  });

  it("Finish during the testimonies: Undo resumes the testimony Finish closed", async () => {
    begin("grouped");
    timer.start();
    timer.next(); // person 1's testimony banked
    await sleep(30);
    const finished = timer.finish(); // closes person 2's testimony, no baptisms
    const banked = finished.people[1]!.testimonyMs;
    assert.ok(banked > 0, "sanity: person 2's testimony banked time, or resuming it and restarting it read the same");

    const back = timer.undo();
    assert.equal(back.phase, "testimony", "back in the testimonies, not in a baptism");
    assert.equal(back.people.length, 1, "person 2 is the running testimony again, not a closed entry");
    assert.equal(back.personNumber, 2);
    assert.equal(back.segmentAccumMs, banked, "resumed from what it banked, like every return into a testimony");
    assert.notEqual(back.segmentStartedAt, null);
    assert.equal(back.finishedFrom ?? null, null);
  });

  it("Last person out, then Undo: the last person re-timed, as before", () => {
    begin("grouped");
    timer.start();
    timer.next();
    timer.startBaptisms();
    timer.advance();
    timer.next(); // person 1 out, person 2 in
    const finished = timer.finish(); // "Last person out" is finish() on the last person

    const back = timer.undo();
    assert.equal(back.phase, "baptism");
    assert.equal(back.baptismIndex, 1);
    assert.equal(baptized(back)[0], finished.people[0]!.baptizeMs, "person 1's baptism is untouched");
    assert.equal(baptized(back)[1], 0, "person 2 is re-timed from zero");
  });

  it("a record finished before finishedFrom existed reopens a baptism at the index Finish left", async () => {
    // Drives the real store and init(): only a PERSISTED record can lack the
    // field. The 900ms drains commit()'s 800ms persist debounce from the tests
    // above, so their write cannot land on top of this one.
    await sleep(900);
    const legacy = {
      mode: "grouped",
      phase: "idle",
      personNumber: 3,
      baptismIndex: 0,
      armed: false,
      segmentStartedAt: null,
      segmentAccumMs: 12_000,
      sessionStartedAt: "2026-09-20T15:00:00.000Z",
      finishedAt: "2026-09-20T15:20:00.000Z",
      people: [
        { testimonyMs: 60_000, baptizeMs: 12_000 },
        { testimonyMs: 50_000, baptizeMs: 0 },
        { testimonyMs: 40_000, baptizeMs: 0 },
      ],
      pendingTestimonyMs: null,
      serviceTitle: null,
      serviceTypeId: null,
      planId: null,
    } as unknown as BaptismState;
    await baptismStore.saveCurrent(legacy);
    await timer.init();
    assert.equal(timer.getState().finishedFrom ?? null, null, "sanity: the restored record has no finishedFrom");

    const back = timer.undo();
    assert.equal(back.phase, "baptism");
    assert.equal(back.baptismIndex, 0, "the index finalize() left, not the last person");
    assert.deepEqual(baptized(back), [0, 0, 0]);

    timer.reset();
    await baptismStore.saveCurrent(null);
  });

  it("a damaged record whose baptismIndex is out of range reopens on a real person, so the next press cannot throw", async () => {
    // Reading the index finalize() left is new: the old branch computed one
    // from people.length, always in range. A restored record can say anything,
    // and next() reads people[baptismIndex] — out of range, that is a TypeError
    // out of POST /api/baptism/next.
    for (const [stored, expected] of [[5, 1], [-1, 0]] as const) {
      await sleep(900); // drain the previous persist, as above
      await baptismStore.saveCurrent({
        mode: "grouped",
        phase: "idle",
        personNumber: 2,
        baptismIndex: stored,
        armed: false,
        segmentStartedAt: null,
        sessionStartedAt: "2026-09-20T15:00:00.000Z",
        finishedAt: "2026-09-20T15:20:00.000Z",
        finishedFrom: "baptism",
        people: [
          { testimonyMs: 60_000, baptizeMs: 12_000 },
          { testimonyMs: 50_000, baptizeMs: 9_000 },
        ],
        pendingTestimonyMs: null,
        serviceTitle: null,
        serviceTypeId: null,
        planId: null,
      });
      await timer.init();

      const back = timer.undo();
      assert.equal(back.baptismIndex, expected, `a stored index of ${stored} reopens on person ${expected + 1}`);
      assert.doesNotThrow(() => timer.next(), "the next press reads a person who exists");

      timer.reset();
      await baptismStore.saveCurrent(null);
    }
  });
});

describe("per-person: Undo after Finish reopens the segment Finish closed", () => {
  it("Finish during a testimony: Undo resumes that testimony, not a baptism", async () => {
    begin("per-person");
    timer.start();
    timer.baptized();
    timer.next(); // person 1 complete, person 2's testimony
    await sleep(30);
    const finished = timer.finish(); // closes person 2's testimony, never baptized
    const banked = finished.people[1]!.testimonyMs;
    assert.ok(banked > 0, "sanity: person 2's testimony banked time, or resuming it and restarting it read the same");

    const back = timer.undo();
    assert.equal(back.phase, "testimony", "person 2 is still speaking");
    assert.equal(back.people.length, 1, "person 2 is the running testimony again, not a closed entry");
    assert.equal(back.personNumber, 2);
    assert.equal(back.pendingTestimonyMs, null, "nothing is pending: the testimony is the running segment");
    assert.equal(back.segmentAccumMs, banked, "resumed from what it banked");
    assert.notEqual(back.segmentStartedAt, null);
  });

  it("Finish during a baptism: Undo re-times that baptism with the testimony pending, as before", async () => {
    begin("per-person");
    timer.start();
    await sleep(20);
    timer.baptized();
    const finished = timer.finish();
    const testimony = finished.people[0]!.testimonyMs;

    const back = timer.undo();
    assert.equal(back.phase, "baptism");
    assert.equal(back.people.length, 0);
    assert.equal(back.personNumber, 1);
    assert.equal(back.pendingTestimonyMs, testimony, "the testimony waits for its baptism again");
    assert.equal(back.segmentAccumMs, 0, "the baptism is re-timed from zero");
  });
});
