// use-servicecue-layouts.ts — the ServiceCue layouts, read once for a picker.
//
// The one read two pickers shared as copies (a view's Layout select, and an Embedded
// view's "Shows the <layout> layout" line). A failed read is not "no layouts" and a read
// still in flight is not a failure: `layouts` is null until an answer has landed, and
// `failed` is true only after the read really failed, with a line on /log.
//
// Not the other readers of this channel: the rundown pages refresh it on a stream and
// retry it, the layouts page saves through it, and the launcher reads it beside the
// service types in one Promise.all. Those are not one-shot reads.

import { useEffect, useState } from "react";

import type { ServiceCueLayout } from "../../main/types/pco.js";
import { invoke } from "./api";
import { useFailedReads } from "./use-failed-reads";

export function useServiceCueLayouts(
  enabled: boolean,
  log: { tag: string; what: string },
): { layouts: ServiceCueLayout[] | null; failed: boolean } {
  const [layouts, setLayouts] = useState<ServiceCueLayout[] | null>(null);
  const { failed, fail, clear } = useFailedReads<"layouts">(log.tag);
  const { what } = log;
  useEffect(() => {
    if (!enabled) return;
    // Cancelled when `enabled` flips or the component goes, so a slow answer or failure
    // from a read that no longer applies cannot replace a later read's.
    let cancelled = false;
    invoke<ServiceCueLayout[]>("servicecue:listLayouts")
      .then((l) => {
        if (cancelled) return;
        setLayouts([...l].sort((a, b) => a.order - b.order));
        clear("layouts");
      })
      .catch((err: unknown) => {
        if (!cancelled) fail("layouts", what, err);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, what, fail, clear]);
  return { layouts, failed: failed.has("layouts") };
}
