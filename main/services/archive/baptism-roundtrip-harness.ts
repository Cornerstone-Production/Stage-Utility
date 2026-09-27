// baptism-roundtrip-harness.ts — what the baptism round-trip guards share.
//
// rebuild-baptism-roundtrip.test.ts and baptism-lane-roundtrip.test.ts both drive
// the REAL baptismTimerService against a real temp data dir and read back the rows
// the real sampleArchive wrote. This is the part of that they have in common, so
// the two guards cannot drift apart on how a service is opened or when a stored
// session counts as landed.
//
// TEST-ONLY, and imported only AFTER the caller has pointed STAGE_UTILITY_DATA at
// a temp dir: this module imports the timer, whose stores resolve their paths
// when they are constructed. Import it with `await import(...)` below that setup,
// the same way each test file imports the services themselves.

import type { BaptismSession } from "../../types/stage.js";
import { baptismTimerService } from "../baptism-timer-service.js";
import { serviceTimelineRecorder } from "../service-timeline-recorder.js";

export interface ServiceCtx {
  serviceKey: string;
  serviceDate: string;
}

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let ctxCounter = 0;
/**
 * A service nothing else in this process has used.
 *
 * Each `it` takes its own: the archive is an append-only CSV keyed by serviceKey,
 * and the singleton sampleArchive never resets between tests in one file.
 */
export function freshCtx(label: string): ServiceCtx {
  ctxCounter += 1;
  return { serviceKey: `st1:plan1:${label}${ctxCounter}`, serviceDate: "2026-09-20" };
}

/** Open this service on the timeline recorder, which is the gate emitRaw checks. */
export function openService(ctx: ServiceCtx): void {
  (serviceTimelineRecorder as unknown as Held).current = { ...ctx, endedAt: null };
}

/**
 * The sessions the store holds for this service, newest first, once the
 * fire-and-forget save behind the LAST finalize() has settled: at least `count`
 * of them, the newest carrying the timer's own `finishedAt`. Polled rather than
 * slept on — the save is a queued read-modify-write, not a fixed delay.
 *
 * Waiting on `finishedAt`, not merely on a session existing: finish, undo,
 * finish saves the same id twice, and a poll that stops at the first save
 * compares the rows against a session the second one has already replaced.
 * Call it only once the timer has finished; a running timer has no finishedAt
 * to wait for.
 */
export async function storedSessions(ctx: ServiceCtx, count = 1): Promise<BaptismSession[]> {
  const finishedAt = baptismTimerService.getState().finishedAt;
  for (let i = 0; i < 200; i++) {
    const found = (await baptismTimerService.listSessions()).filter((s) => s.serviceKey === ctx.serviceKey);
    if (found.length >= count && found[0]!.finishedAt === finishedAt) return found;
    await sleep(5);
  }
  throw new Error(`no stored session for ${ctx.serviceKey} finished at ${finishedAt} after 1s`);
}
