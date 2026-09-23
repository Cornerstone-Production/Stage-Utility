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

import { baptismSessionId, type BaptismState } from "../types/stage.js";

const { baptismTimerService: timer } = await import("./baptism-timer-service.js");
const { baptismStore } = await import("./baptism-store.js");
const { addBroadcastListener } = await import("./broadcaster.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };
const rec = () => serviceTimelineRecorder as unknown as Held;

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

    const failedId = timer.getState().saveErrorSessionId;
    assert.ok(failedId, "sanity: the failed session's own id was captured");

    // A PCO auto-start calls exactly start() — it must not erase a failure
    // before anybody has looked at the screen.
    const toggled = timer.setMode("per-person");
    assert.equal(toggled.saveError, REASON, "switching the workflow keeps it");
    assert.equal(toggled.saveErrorSessionId, failedId, "and keeps naming which session it was");
    const started = timer.start();
    assert.equal(started.phase, "testimony", "sanity: a new session is running");
    assert.equal(started.saveError, REASON, "starting the next session keeps it");
    assert.equal(started.saveErrorSessionId, failedId, "starting the next session keeps naming it too");

    const cleared = timer.reset();
    assert.equal(cleared.saveError ?? null, null, "Reset is the operator dismissing it");
    assert.equal(cleared.saveErrorSessionId ?? null, null, "Reset clears the id alongside the message");
    assert.equal(cleared.saveErrorServiceKey ?? null, null, "Reset clears the serviceKey alongside the message");
  });

  it("a different session's successful save does not clear an earlier one's unsaved failure", async () => {
    // Session A fails to save, the operator runs session B, B saves cleanly —
    // the note must remain, because A was never written. Without the scope,
    // B's success clears saveError for anybody whose id happens to be
    // showing, regardless of whose save actually landed.
    rec().current = { serviceKey: "st1:plan1:save-error-scope", serviceDate: "2026-09-20", endedAt: null };
    const log = captureError("[baptism-timer] session save failed:");
    const restore = stubAddSession(rejecting);
    try {
      const mark = await finishOnePerson(); // session A
      await pushWhere(mark, (s) => !!s.saveError, "carrying saveError for A");
    } finally {
      restore();
      log.release();
    }
    const failedId = timer.getState().saveErrorSessionId;
    const failedServiceKey = timer.getState().saveErrorServiceKey;
    assert.ok(failedId, "sanity: A's own id was captured");
    assert.equal(failedServiceKey, "st1:plan1:save-error-scope", "sanity: A's own serviceKey was captured");

    // Session B starts WITHOUT a Reset — the ordinary case of an operator
    // running the next baptism having seen, or not yet seen, A's note — and
    // this time the store really writes (restore() above put the real
    // addSession back).
    await sleep(5); // guarantee B's sessionStartedAt differs from A's
    const started = timer.start();
    assert.equal(started.saveError, REASON, "sanity: starting B still carries A's note");
    assert.equal(started.saveErrorSessionId, failedId, "sanity: and still names A specifically");
    await sleep(5);
    const mark2 = pushes.length;
    const finishedB = timer.finish();
    assert.equal(finishedB.people.length, 1, "sanity: B has its own session to save");
    await pushWhere(mark2, (s) => s.phase === "idle" && s.finishedAt != null, "B's finish push");

    // Give B's save every chance to land — and to wrongly clear A's note —
    // before asserting it did not.
    await sleep(80);
    const after = timer.getState();
    assert.equal(after.saveError, REASON, "A's note must survive an unrelated session's successful save");
    assert.equal(after.saveErrorSessionId, failedId, "still scoped to A's id, not B's");
    assert.equal(after.saveErrorServiceKey, failedServiceKey, "still naming A's service, not B's");

    // Checked by id, not by count: earlier tests in this file leave their own
    // successful saves in this same shared store, so the store's total size
    // is not this test's business — whether B and not A is.
    const stored = await baptismStore.listSessions();
    const bId = baptismSessionId(started.sessionStartedAt!);
    assert.ok(stored.some((s) => s.id === bId), "B's session must actually be in the store");
    assert.ok(!stored.some((s) => s.id === failedId), "A's session must never appear in the store");

    timer.reset();
    rec().current = null;
  });

  it("saveErrorSessionId and saveErrorServiceKey persist and restore alongside saveError", async () => {
    rec().current = { serviceKey: "st1:plan1:save-error-persist", serviceDate: "2026-09-20", endedAt: null };
    const log = captureError("[baptism-timer] session save failed:");
    const restore = stubAddSession(rejecting);
    try {
      const mark = await finishOnePerson();
      await pushWhere(mark, (s) => !!s.saveError, "carrying saveError");
    } finally {
      restore();
      log.release();
    }
    const before = timer.getState();
    assert.ok(before.saveErrorSessionId, "sanity: the failed session's id was captured");
    assert.equal(before.saveErrorServiceKey, "st1:plan1:save-error-persist", "sanity: and its serviceKey");

    await sleep(850); // past commit()'s 800ms persist debounce
    await timer.init(); // simulates a restart: reads back whatever was actually written
    const after = timer.getState();
    assert.equal(after.saveError, before.saveError, "the message survives a restart");
    assert.equal(after.saveErrorSessionId, before.saveErrorSessionId, "the failed session's id survives a restart");
    assert.equal(
      after.saveErrorServiceKey,
      before.saveErrorServiceKey,
      "and its serviceKey, for PR 3's Rebuild offer",
    );

    timer.reset();
    rec().current = null;
  });
});

// Switching the workflow carries the failure into an idle state with nobody
// in it, where the Timer card renders neither Reset nor Undo — so without a
// control of its own the note stayed up until some later session's save.
// Dismissing is the operator's choice, and only theirs: nothing else clears it.
describe("the operator can dismiss a failed save", () => {
  async function failSave(): Promise<void> {
    const log = captureError("[baptism-timer] session save failed:");
    const restore = stubAddSession(rejecting);
    try {
      const mark = await finishOnePerson();
      await pushWhere(mark, (s) => !!s.saveError, "carrying saveError");
    } finally {
      restore();
      log.release();
    }
  }

  function captureDismissLog(): { lines: string[]; release: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[baptism-timer] save failure dismissed")) lines.push(args[0]);
      else original(...args);
    };
    return { lines, release: () => void (console.log = original) };
  }

  it("clears it after the workflow toggle, where no other control shows, and says so on a push", async () => {
    await failSave();
    const toggled = timer.setMode("per-person");
    assert.equal(toggled.saveError, REASON, "sanity: the toggle carried it");
    assert.equal(toggled.people.length, 0, "sanity: nobody in the state, so the card offers no Reset or Undo");

    const log = captureDismissLog();
    const mark = pushes.length;
    let dismissed: BaptismState;
    try {
      dismissed = timer.dismissSaveError();
    } finally {
      log.release();
    }
    assert.equal(dismissed.saveError, null);
    assert.equal(pushes[mark]?.saveError, null, "every screen hears it on a push, not just this caller");
    assert.equal(dismissed.mode, "per-person", "and nothing else about the state moves");
    assert.deepEqual(log.lines, [`[baptism-timer] save failure dismissed: ${REASON}`]);
    timer.reset();
  });

  it("leaves a running session exactly as it was", async () => {
    await failSave();
    const running = timer.start(); // the next session, carrying the failure
    assert.equal(running.saveError, REASON, "sanity");
    assert.ok(running.saveErrorSessionId, "sanity: the failed session's id carried forward too");
    const dismissed = timer.dismissSaveError();
    assert.equal(dismissed.saveErrorSessionId, null, "dismiss clears the id, not just the message");
    assert.equal(dismissed.saveErrorServiceKey, null, "dismiss clears the serviceKey, not just the message");
    assert.deepEqual(
      {
        ...dismissed,
        saveError: REASON,
        saveErrorSessionId: running.saveErrorSessionId,
        saveErrorServiceKey: running.saveErrorServiceKey,
      },
      running,
      "only the saveError/saveErrorSessionId/saveErrorServiceKey trio changed",
    );
    timer.reset();
  });

  it("with nothing to dismiss, pushes nothing", () => {
    timer.reset();
    const mark = pushes.length;
    timer.dismissSaveError();
    assert.equal(pushes.length, mark, "no failure, no push");
  });
});

// The reason goes to every screen on the LAN, so it must be path-free by
// construction: built from the errno number alone, never from a string the
// error carries. Today's write path only rejects with fs errors, so these
// errors are made by hand — which is the point: they are the ones a filter on
// the message or the code would let through.
describe("what a failed save may put on the screen is built from the errno alone", () => {
  const SECRET = path.join(TMP, "private", "baptism.json");

  async function reasonFor(error: unknown): Promise<string | null | undefined> {
    const log = captureError("[baptism-timer] session save failed:");
    const restore = stubAddSession(async () => {
      throw error;
    });
    try {
      const mark = await finishOnePerson();
      return (await pushWhere(mark, (s) => !!s.saveError, "carrying saveError")).saveError;
    } finally {
      restore();
      log.release();
      timer.reset();
    }
  }

  it("an error with no errno gets a fixed sentence, never its own message", async () => {
    const reason = await reasonFor(new Error(`could not write ${SECRET}`));
    assert.equal(reason, "an unexpected error; the log has the details");
    assert.ok(!reason!.includes(TMP), "the message named a path, and none of it may reach the screen");
  });

  it("a system error's own code and message are not read — only its errno", async () => {
    const doctored = Object.assign(new Error(`EACCES: permission denied, open '${SECRET}'`), {
      errno: -13,
      code: SECRET,
      path: SECRET,
    });
    const reason = await reasonFor(doctored);
    assert.equal(reason, "EACCES: permission denied", "both halves come from Node's table for errno -13");
  });

  it("anything thrown that is not an object at all gets the fixed sentence too", async () => {
    assert.equal(await reasonFor(SECRET), "an unexpected error; the log has the details");
  });

  it("an errno past the safe-integer range gets the fixed sentence, and the handler does not throw", async () => {
    // Both lookups throw ERR_OUT_OF_RANGE on any integer below
    // Number.MIN_SAFE_INTEGER. Inside the rejection handler that throw is an
    // unhandled rejection, and it lands before saveError is set: the log line
    // written, nothing on any screen.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const reason = await reasonFor(Object.assign(new Error(`could not write ${SECRET}`), { errno: -(2 ** 60) }));
      assert.equal(reason, "an unexpected error; the log has the details");
      await sleep(20); // room for a stray rejection to surface
      assert.deepEqual(unhandled.map(String), [], "the rejection handler itself must not throw");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
