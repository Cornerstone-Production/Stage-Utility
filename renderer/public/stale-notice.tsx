// The public page's one addition: "Not updating".
//
// When the church has sent nothing for two minutes the page says so, in a bar across the
// top, and takes it back by itself when updates resume. It is a row of its own above the
// page, not laid over it, so it covers none of the page's controls.
//
// What it reads is public-live.ts's PublicFreshness, all of it on this page's own
// monotonic clock. The threshold is a parameter so a case need not wait two minutes.

import { useEffect, useState, useSyncExternalStore } from "react";

import { PUBLIC_STALE_AFTER_MS } from "@main/types/servicecue-publish";
import { formatClock } from "../lib/clock-format";
import { edgeTimeOf, getPublicFreshness, subscribePublicFreshness } from "../lib/public-live";
import { monotonicNow } from "../lib/server-clock";
import { useStageState } from "../main/use-stage-state";

/** How often the notice looks at the clock. It needs to be right to the half-minute. */
const CHECK_EVERY_MS = 5_000;

/** The monotonic clock as state, so one render reads a moment and a later one a later moment. */
function useMonotonicNow(everyMs: number): number {
  const [now, setNow] = useState(monotonicNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(monotonicNow()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

export function StaleNotice({ staleAfterMs = PUBLIC_STALE_AFTER_MS }: { staleAfterMs?: number }) {
  const { heardAtMono, watchingSinceMono } = useSyncExternalStore(subscribePublicFreshness, getPublicFreshness, getPublicFreshness);
  const now = useMonotonicNow(CHECK_EVERY_MS);
  // The app's time zone, which the page's header clock reads in, and not the rundown's:
  // the notice sits outside the page and cannot see which rundown it shows.
  const { state } = useStageState();

  // With nothing ever heard, the silence is counted from when the page began watching.
  const stale = now - (heardAtMono ?? watchingSinceMono) > staleAfterMs;

  return (
    // The live region is always in the page and only its contents come and go, so a
    // screen reader is told when the notice arrives instead of finding it already there.
    // Empty, it has no height.
    <div role="status" className="shrink-0">
      {stale && (
        <div className="flex items-center gap-2.5 bg-[rgba(161,92,7,0.94)] px-3.5 py-2 text-[13px] text-white">
          <span>
            <b className="font-semibold">Not updating.</b>{" "}
            {heardAtMono === null
              ? "The church has not sent an update yet."
              : `The last update from the church was at ${formatClock(edgeTimeOf(heardAtMono), { timeZone: state?.timezone })}. The live item may have moved on.`}
          </span>
        </div>
      )}
    </div>
  );
}
