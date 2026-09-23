// baptism-save-error.test.ts — a Finish whose session save fails says so.
//
// finalize() hands the finished session to baptismStore.addSession and returns
// before the write settles. A rejection used to be `.catch`-ed with a log line
// and nothing else, so the operator's screen read "Finished" for a session that
// was never written — on the one record this app keeps of a baptism. The failure
// now lands on BaptismState.saveError and goes out on a push of its own.
//
// Driven through the REAL timer with only addSession stubbed, and read off the
// pushes themselves, through the same broadcast hub the SSE transport listens
// on: the claim is about what reaches the operator's screen, not about what
// getState() returns to a test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-save-error-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import type { BaptismState } from "../types/stage.js";

const { baptismTimerService: timer } = await import("./baptism-timer-service.js");
const { baptismStore } = await import("./baptism-store.js");
const { addBroadcastListener } = await import("./broadcaster.js");

const pushes: BaptismState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "baptism:state") pushes.push(payload as BaptismState);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first push after index `from` that satisfies `test`. Polled: the save
 *  settles on the store's write queue, not after a fixed delay. */
async function pushWhere(from: number, test: (s: BaptismState) => boolean, what: string): Promise<BaptismState> {
  for (let i = 0; i < 200; i++) {
    const hit = pushes.slice(from).find(test);
    if (hit) return hit;
    await sleep(5);
  }
  const seen = pushes.slice(from).map((s) => ({ phase: s.phase, saveError: s.saveError }));
  assert.fail(`no push ${what} within 1s; pushes since: ${JSON.stringify(seen)}`);
}

type AddSession = typeof baptismStore.addSession;

/** A REAL Node fs error, not a hand-built one: its message names the absolute
 *  path it failed on, the way the store's own failed write does (atomicWrite
 *  rethrows the fs error untouched). */
const FS_ERROR: unknown = await fs.readFile(path.join(TMP, "no-such-dir", "baptism.json")).then(
  () => assert.fail("sanity: that read was supposed to fail"),
  (err: unknown) => err,
);
assert.ok(String((FS_ERROR as Error).message).includes(TMP), "sanity: the raw error names the data directory");
/** What the operator's screen may say about FS_ERROR: why, never where. */
const REASON = "ENOENT: no such file or directory";

/** Replace addSession for the length of one test. Restore in a finally. */
function stubAddSession(impl: AddSession): () => void {
  const store = baptismStore as unknown as { addSession: AddSession };
  const original = store.addSession;
  store.addSession = impl;
  return () => {
    store.addSession = original;
  };
}
const rejecting: AddSession = async () => {
  throw FS_ERROR;
};

/** console.error lines starting with `prefix`, so the log line this change
 *  keeps is proven kept. Release in a finally. */
function captureError(prefix: string): { lines: unknown[][]; release: () => void } {
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(prefix)) lines.push(args);
    else original(...args);
  };
  return {
    lines,
    release: () => {
      console.error = original;
    },
  };
}

/** One grouped session with one person's testimony, finished. Returns the
 *  push index from just before the Finish press. */
async function finishOnePerson(): Promise<number> {
  timer.reset();
  timer.setMode("grouped");
  timer.start();
  await sleep(5);
  const mark = pushes.length;
  const finished = timer.finish();
  assert.equal(finished.phase, "idle", "sanity: the session finished");
  assert.equal(finished.people.length, 1, "sanity: there is a session to save");
  return mark;
}

describe("a session save that fails reaches the operator", () => {
  it("arrives on a push, survives the next press, and a save that lands clears it", async () => {
    const log = captureError("[baptism-timer] session save failed:");
    const restore = stubAddSession(rejecting);
    try {
      const mark = await finishOnePerson();
      // Finish returns before the write settles, so its OWN push cannot know
      // yet — the failure has to travel on a push of its own.
      assert.equal(pushes[mark]!.saveError ?? null, null, "sanity: Finish's own push predates the failure");

      const failed = await pushWhere(mark, (s) => !!s.saveError, "carrying saveError");
      assert.equal(failed.saveError, REASON, "the push names what went wrong");
      assert.ok(
        !failed.saveError!.includes(TMP),
        "and not where: the state goes to every screen on the LAN, where a filesystem path must never be readable",
      );
      assert.equal(failed.phase, "idle", "and it is the finished session's push, the one on the operator's screen");
      assert.equal(timer.getState().saveError, REASON);
      assert.equal(log.lines.length, 1, "the [baptism-timer] session save failed: line is still written");
      assert.equal(log.lines[0]![1], FS_ERROR, "and the log line keeps the whole error, path and all");

      // The next press must not wipe a failure the operator may not have seen.
      const beforeUndo = pushes.length;
      const reopened = timer.undo();
      assert.equal(reopened.finishedAt, null, "sanity: Undo reopened the session");
      assert.equal(pushes[beforeUndo]!.saveError, REASON, "the next push still carries it");
    } finally {
      restore();
      log.release();
    }

    // Finish again with the store writing: the save lands, and says so.
    const retry = pushes.length;
    timer.finish();
    await pushWhere(retry, (s) => s.phase === "idle" && s.saveError === null, "clearing saveError");
    assert.equal(timer.getState().saveError, null, "a save that lands clears the failure");
    const stored = await baptismStore.listSessions();
    assert.equal(stored.length, 1, "sanity: the retried session really is in the store");

    timer.reset();
  });

  it("is carried across the workflow toggle and a new Start, and cleared by Reset", async () => {
    const log = captureError("[baptism-timer] session save failed:");
    const restore = stubAddSession(rejecting);
    try {
      const mark = await finishOnePerson();
      await pushWhere(mark, (s) => !!s.saveError, "carrying saveError");
    } finally {
      restore();
      log.release();
    }

    // A PCO auto-start calls exactly start() — it must not erase a failure
    // before anybody has looked at the screen.
    const toggled = timer.setMode("per-person");
    assert.equal(toggled.saveError, REASON, "switching the workflow keeps it");
    const started = timer.start();
    assert.equal(started.phase, "testimony", "sanity: a new session is running");
    assert.equal(started.saveError, REASON, "starting the next session keeps it");

    const cleared = timer.reset();
    assert.equal(cleared.saveError ?? null, null, "Reset is the operator dismissing it");
  });
});
