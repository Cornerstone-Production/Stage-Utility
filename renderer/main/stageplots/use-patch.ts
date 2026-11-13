// use-patch.ts — the patch a stage plot's linked connection points resolve against, read
// once and then live on patch:updated, as /patch reads it.
//
// The read is GET /api/stageplots/patch, which answers 503 when the patch cannot be read
// rather than the seed sheets /api/patch falls back to: against those every link would read
// "device removed". A failed read is the patch unavailable, said once on [stageplots], and
// every linked point shows its last name and colour, "unlinked", until a read or a save
// answers. Null until the first answer: the points show what they last saved.

import { useCallback, useMemo } from "react";

import type { PatchFile } from "@main/types/patch";
import type { PatchContext, PatchRead } from "@main/services/stageplots-patch-link";

import { logReadFailure } from "../../lib/client-log";
import { useStatusChannel } from "../use-status-channel";
import { useStageState } from "../use-stage-state";
import { stageplotsApi } from "./stageplots-api";

export function useStagePlotsPatch(): PatchRead | null {
  const read = useCallback(
    () =>
      stageplotsApi.patch().catch((err: unknown) => {
        logReadFailure("stageplots", "the patch sheet for linked connection points", err);
        throw err;
      }),
    [],
  );
  const { value, known, failed } = useStatusChannel<PatchFile>(read, "patch:updated", true, { clearOnReadFailure: true });
  return useMemo(() => (!known ? null : failed || !value ? { ok: false } : { ok: true, file: value }), [known, failed, value]);
}

/** The plan a link lists channels for: `planId` (the followed plan, or null) and the stage
 *  state's service type, whose standing variant /patch applies too. */
export function usePatchContext(planId: string | null): PatchContext {
  const { state } = useStageState();
  const serviceTypeId = state?.serviceTypeId ?? null;
  return useMemo(() => ({ serviceTypeId, planId }), [serviceTypeId, planId]);
}
