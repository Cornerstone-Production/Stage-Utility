// baptism-save-harness.ts — intercept baptismStore.addSession for a test.
//
// NOT shipped code and not a test file: shared by the test files that need a
// Finish's session save to fail, or need to know when it has settled, the way
// routes/route-harness.ts is shared.
//
// finalize() fires the save and returns, so nothing a test can read off the
// timer says when the save has landed. Guessing — a fixed sleep, a bounded
// poll, listSessions() showing the session (the store caches a write before it
// reaches disk) — is how baptism-actions.test.ts flaked: its "finish" row's
// real save was still in flight when the next row's stubbed save failed, and a
// session's id is `bap-<start ms>`, so two rows a fraction of a millisecond
// apart shared one. The late success then cleared the failed save's saveErrors
// entry as "that session saved". Recording each call's own promise lets a test
// await the save itself.
//
// Takes the store rather than importing it: every caller points
// STAGE_UTILITY_DATA at a scratch directory before its first dynamic import,
// and a static import here would load the store before that.

import type { BaptismSession } from "../types/stage.js";

export type AddSession = (session: BaptismSession) => Promise<void>;

export interface SaveIntercept {
  /** Every addSession call made while installed, oldest first. Each is the
   *  SAME promise finalize() attached its handlers to, so a test resuming
   *  after one settles resumes after finalize() has applied its outcome to
   *  the timer. */
  readonly calls: Promise<void>[];
  /** Resolves once every recorded call has settled, whichever way. */
  settled(): Promise<void>;
  /** Put back whatever addSession was before. Call it in a finally. */
  restore(): void;
}

/** Route `store.addSession` through `impl` — the real one when omitted, so
 *  the store still writes — recording every call. */
export function interceptAddSession(store: { addSession: AddSession }, impl?: AddSession): SaveIntercept {
  const original = store.addSession;
  const target = impl ?? original.bind(store);
  const calls: Promise<void>[] = [];
  store.addSession = (session) => {
    const saved = target(session);
    calls.push(saved);
    return saved;
  };
  return {
    calls,
    settled: async () => {
      await Promise.allSettled(calls);
    },
    restore: () => {
      store.addSession = original;
    },
  };
}
