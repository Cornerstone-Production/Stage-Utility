// use-patch.ts — the patch a stage plot's linked connection points resolve against, read
// once and then live on patch:updated, as /patch reads it.
//
// The read is GET /api/stageplots/patch, which answers 503 when the patch cannot be read
// rather than the seed sheets /api/patch falls back to: against those every link would read
// "device removed". A failed read is the patch unavailable, said on [stageplots], and every
// linked point shows its last name and colour, "unlinked". It is read again on a backoff
// (PATCH_REREAD: a minute, doubling to fifteen) until it answers, and any patch:updated answers
// at once, so a page left open follows the patch again once it can be read. Null until the
// first answer: the points show what they last saved. A read again keeps showing the last
// answer until it lands.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PatchFile } from "@main/types/patch";
import type { PatchContext, PatchRead } from "@main/services/stageplots-patch-link";

import { logReadFailure } from "../../lib/client-log";
import { useResyncOn } from "../../lib/use-resync-on";
import { useStatusChannel } from "../use-status-channel";
import { useStageState } from "../use-stage-state";
import { stageplotsApi } from "./stageplots-api";

/** How long after a failed read the patch is read again, doubling up to maxMs. Mutable for a test. */
export const PATCH_REREAD = { firstMs: 60_000, maxMs: 15 * 60_000 };

export function useStagePlotsPatch(): PatchRead | null {
  // Each read again is a new attempt: a new read, which useStatusChannel answers afresh. The
  // read must USE `attempt`: the build's React Compiler memoises this callback by what it reads,
  // and a read that only listed it (`void attempt`) was compiled to one static function, so no
  // read again ever went out in the browser while the jsdom suite, which is not compiled,
  // passed. Driven in a browser for that reason; the log line names the read again.
  const [attempt, setAttempt] = useState(0);
  const read = useCallback(
    () =>
      stageplotsApi.patch().catch((err: unknown) => {
        logReadFailure("stageplots", attempt === 0 ? "the patch sheet for linked connection points" : `the patch sheet for linked connection points (read again, attempt ${attempt})`, err);
        throw err;
      }),
    [attempt],
  );
  const { value, known, failed } = useStatusChannel<PatchFile>(read, "patch:updated", true, { clearOnReadFailure: true });
  const settled = useMemo<PatchRead | null>(() => (!known ? null : failed || !value ? { ok: false } : { ok: true, file: value }), [known, failed, value]);

  const delay = useRef(PATCH_REREAD.firstMs);
  useEffect(() => {
    if (!known) return;
    if (!failed) {
      delay.current = PATCH_REREAD.firstMs;
      return;
    }
    const t = setTimeout(() => {
      delay.current = Math.min(delay.current * 2, PATCH_REREAD.maxMs);
      setAttempt((a) => a + 1);
    }, delay.current);
    return () => clearTimeout(t);
  }, [known, failed]);

  const [last, setLast] = useState<PatchRead | null>(null);
  useResyncOn([settled], () => {
    if (settled) setLast(settled);
  });
  return settled ?? last;
}

/** The plan a link lists channels for: `planId` (the followed plan, or null) and the stage
 *  state's service type, whose standing variant /patch applies too. */
export function usePatchContext(planId: string | null): PatchContext {
  const { state } = useStageState();
  const serviceTypeId = state?.serviceTypeId ?? null;
  return useMemo(() => ({ serviceTypeId, planId }), [serviceTypeId, planId]);
}
