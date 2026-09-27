// A GET /api/baptism/sessions made on Finish's own baptism:state push used to
// race the session to disk.
//
// finalize() (baptism-timer-service.ts) fires baptismStore.addSession(...)
// without awaiting it, then broadcasts baptism:state in the same call. A
// Baptisms tab or History page open elsewhere reloads its sessions on exactly
// that push (reload-on-baptism-change.ts) — a LOCAL Finish is covered by the
// Timer card's own onFinished, which refetches regardless of the push, but a
// Finish fired from Companion (automation's baptism.finish action) has nothing
// else telling that browser to reload. If addSession's own write is still
// queued behind another write already in flight (baptismStore.saveCurrent, the
// same store's own 800ms debounce or a concurrent request), a read answered in
// that window comes back a session short.
//
// Reproduced here by holding the store's own next write open (patching
// writeRaw, the same seam baptism-store.test.ts's spyOnWrite uses) rather than
// racing a real concurrent saveCurrent — deterministic, and exactly the
// "queue busy" case the bug depends on: without it, addSession's own task is
// the ONLY thing queued and normally clears before anything else can read.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-finish-race-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import { sleep } from "./baptism-save-harness.js";
import type { BaptismState } from "../types/stage.js";

const { baptismTimerService: timer } = await import("./baptism-timer-service.js");
const { baptismStore } = await import("./baptism-store.js");
const { addBroadcastListener } = await import("./broadcaster.js");

const pushes: BaptismState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "baptism:state") pushes.push(payload as BaptismState);
});

/** The private DataStore backing baptismStore — same cast baptism-store.test.ts's
 *  spyOnWrite already uses to reach writeRaw. */
const internals = (baptismStore as unknown as { store: { writeRaw: (data: unknown) => Promise<void> } }).store;

/**
 * Hold the NEXT write to land on this store open until released.
 *
 * Patches writeRaw once, for exactly one call, then restores itself before
 * delegating — every write after the held one runs normally. Triggered with a
 * real saveCurrent() (fire-and-forget, matching commit()'s own call shape),
 * so this is a genuine write occupying the store's real WriteQueue, not a
 * fake gate the queue itself does not know about.
 */
function holdNextWrite(): { release: () => void } {
  const original = internals.writeRaw.bind(internals);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  internals.writeRaw = async (data: unknown) => {
    internals.writeRaw = original;
    await held;
    return original(data);
  };
  void baptismStore.saveCurrent(timer.getState());
  return { release };
}

describe("a sessions read on Finish's own push", () => {
  it("reproduces: with the store's write queue busy, the read misses the session it was pushed for", async () => {
    timer.reset();
    timer.setMode("grouped");
    timer.start();
    await sleep(5);

    const hold = holdNextWrite();
    await sleep(20); // let saveCurrent's own task reach writeRaw and start hanging

    const mark = pushes.length;
    const finished = timer.finish();
    assert.equal(finished.phase, "idle", "sanity: the session finished");
    assert.equal(finished.people.length, 1, "sanity: there is a session to save");
    assert.ok(pushes.length > mark, "sanity: finish() pushed baptism:state");

    // The read a Baptisms tab or History page makes on that exact push,
    // while addSession's own write is still queued behind the held one. NOT
    // awaited before the release below: a fixed read waits for the queue to
    // drain rather than answering early, and awaiting it first would
    // deadlock this test on its own hold, not merely prove the bug.
    const read = timer.listSessions();
    hold.release();
    const sessions = await read;
    await sleep(20); // let addSession's own .then (clearing saveErrors) settle

    assert.ok(
      sessions.some((s) => s.finishedAt === finished.finishedAt),
      "a sessions read on the finish push must include the session that push announced, not read the pre-finish list",
    );

    timer.reset();
    await timer.flush();
  });
});
