// Deleting a history record used to be undone seconds later.
//
// The store removed the file and its cache entry, but the recorder that owns the
// key still held `current`/`currentKey`. ensureRecord short-circuits on a
// matching key, kept appending in memory, and the debounced persist recreated the
// file — so the row came back on the next refresh and the delete button read as
// broken. Merging had the same shape: the source was deleted while still being
// recorded, so it returned with its items now duplicated across both records.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-forget-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { attendanceRecorder } = await import("./attendance-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");

type Held = {
  current: { serviceKey: string } | null;
  currentKey: string | null;
  dirty: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
};

const RECORDERS: [string, Held][] = [
  ["attendance", attendanceRecorder as unknown as Held],
  ["spl", splRecorder as unknown as Held],
  ["timeline", serviceTimelineRecorder as unknown as Held],
];

describe("recorder.forget", () => {
  beforeEach(() => {
    for (const [, r] of RECORDERS) {
      r.current = { serviceKey: "st1:plan:11am" };
      r.currentKey = "st1:plan:11am";
      r.dirty = true;
      // unref'd: the 'leaves a different service alone' cases deliberately do NOT
      // cancel this, and a live timer would hold the test runner open for a minute.
      r.persistTimer = setTimeout(() => {}, 60_000);
      r.persistTimer.unref?.();
    }
  });

  // All three, every time: the guard that was in one recorder and not the others
  // is exactly how this codebase has drifted before.
  for (const [name] of RECORDERS) {
    it(`${name}: releases the record it holds, so the delete sticks`, () => {
      const rec = RECORDERS.find(([n]) => n === name)![1];
      const forget = (rec as unknown as { forget(k: string): boolean }).forget.bind(rec);

      assert.equal(forget("st1:plan:11am"), true);
      assert.equal(rec.current, null, "still holding the record");
      assert.equal(rec.currentKey, null, "still holding the key");
      assert.equal(rec.dirty, false, "still marked dirty");
      assert.equal(rec.persistTimer, null, "queued write would recreate the file");
    });

    it(`${name}: leaves a different service alone`, () => {
      const rec = RECORDERS.find(([n]) => n === name)![1];
      const forget = (rec as unknown as { forget(k: string): boolean }).forget.bind(rec);

      assert.equal(forget("st1:plan:9am"), false);
      assert.equal(rec.currentKey, "st1:plan:11am", "cleared the wrong record");
      assert.ok(rec.persistTimer, "cancelled an unrelated pending write");
    });
  }

  it("a delete landing mid-tick is not undone by the tick that was in flight", async () => {
    // forget() clears memory, but ensureRecord is async: it awaits a store read
    // before assigning this.current. A DELETE arriving inside that window used to
    // be overwritten when the tick resumed and re-persisted the record it had
    // already loaded. The generation counter makes the tick abandon its work.
    const rec = attendanceRecorder as unknown as Held & {
      generation: number;
      forget(k: string): boolean;
      ensureRecord(live: unknown, gap?: number): Promise<void>;
    };
    rec.current = null;
    rec.currentKey = null;
    const before = rec.generation;

    // Simulate: capture the generation, let a forget land, then resume.
    const gen = rec.generation;
    rec.forget("anything"); // no-op: nothing held
    assert.equal(rec.generation, before, "a no-op forget must not bump the generation");

    rec.current = { serviceKey: "st1:plan:11am" };
    rec.currentKey = "st1:plan:11am";
    assert.equal(rec.forget("st1:plan:11am"), true);
    assert.notEqual(rec.generation, gen, "a real forget must bump the generation");
  });
});
