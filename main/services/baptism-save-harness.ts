// baptism-save-harness.ts — intercept baptismStore.addSession for a test, plus
// the small polling/logging utilities several baptism test files need.
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

/** Resolves after `ms` — a poll's own step delay, not a fixed wait for the
 *  thing being polled. Shared here, like interceptAddSession above, so the
 *  baptism test files polling a debounced save or a queued write are not each
 *  keeping their own copy of the same one-liner. Safe to import statically:
 *  this module touches no store, so it carries none of the ordering risk
 *  interceptAddSession's own doc comment warns about. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Spies on console.log for lines starting with `prefix`, so a silent no-op
 *  guard can be proven to say why it did nothing rather than just that it
 *  didn't throw. Restore with release() even on assertion failure. Shared for
 *  the same reason as sleep above: baptism-legacy-restore.test.ts and
 *  baptism-store.test.ts each kept an identical copy. */
export function captureLog(prefix: string): { lines: string[]; release: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(prefix)) lines.push(args[0]);
  };
  return {
    lines,
    release: () => {
      console.log = original;
    },
  };
}

/** Silence the one line a damaged fixture prints starting with `prefix`, and
 *  hand back what it said so the test can assert the operator has something
 *  to read. Shared for the same reason as captureLog above:
 *  baptism-lane.test.ts and rebuild-baptism.test.ts each kept an identical
 *  copy, hardcoding their own tag ("[baptism-lane]" / "[baptism-replay]") in
 *  place of this `prefix` parameter. */
export function captureWarnings<T>(prefix: string, fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(prefix)) warnings.push(args[0]);
    else original(...args);
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}
