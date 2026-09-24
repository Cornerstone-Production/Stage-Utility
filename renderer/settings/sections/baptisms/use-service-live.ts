// use-service-live.ts — whether a service is being recorded, asked directly
// of the server rather than guessed from a record this page holds.
//
// Shared so the save-failure entry's own Rebuild action can reuse it,
// targeting its own serviceKey rather than the page's current target,
// without repeating the entire hook.

import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "@main/services/errors";
import { invoke, onNotification } from "../../../lib/api";
import { logToServer } from "../../../lib/client-log";

/** How often to re-ask while blocked and nothing has told us to — see
 *  useServiceLive's own comment for what this backstops. */
const LIVE_RECHECK_MS = 30_000;

/** The server's own answer to "is this service live", from this page's point
 *  of view: `checking` while a target's first answer for this render is still
 *  in flight (including right after a target change, before its own answer
 *  has arrived — see useServiceLive), `failed` when the ask itself could not
 *  be answered, and `live`/`not-live` otherwise. All but `not-live` disable
 *  the button; baptismRebuildDisabledReason gives each its own reason. */
export type LiveStatus = "checking" | "live" | "not-live" | "failed";

export interface LiveCheck {
  status: LiveStatus;
  /** Ask again right now and update `status` to match, returning the fresh
   *  answer — called immediately before posting, so a confirm dialog left
   *  open across the target starting to record again cannot walk a stale
   *  "not live" into the very 409 this exists to avoid. */
  recheck: () => Promise<LiveStatus>;
  /** The POST route refused with 409 despite the recheck above having just
   *  said otherwise — the write itself is the one true answer; reflect it
   *  without a further round trip. */
  markLive: () => void;
}

/**
 * Whether `serviceKey` is being recorded right now, answered by the SERVER —
 * `GET /api/history/live`, which shares `assertNotLive`'s own expression, so
 * the ROUTE and the refusal can never disagree with each other. This hook's
 * OWN cached copy of that answer can still be stale for as long as it takes
 * to ask again: a network round trip has latency, and a push is only ever a
 * HINT that something changed, not an answer about this one key.
 *
 * Re-asked on mount, on every `serviceKey` change, and on every
 * "service-timeline:history" push. Two things narrow the remaining gap
 * rather than close it outright, because nothing client-side can:
 *
 *   - a slow backstop interval, while the answer is anything but "not live"
 *     (INCLUDING "checking" — an answer for the current target can still be
 *     lost, below, and if it is there is otherwise nothing left to ever ask
 *     again), for the two ways a service can stop recording with no push
 *     ever following it (the live-poller's attendance tick still busy on the
 *     exact closing instant, or no ticks at all for a while — a dropped PCO
 *     poll, or the plan deselected);
 *   - `recheck`/`markLive`, above, for the moment right before and right at
 *     the POST itself.
 *
 * Every answer, from any of the four places that can produce one (the
 * mount/key-change effect, the backstop, `recheck`, `markLive`), is accepted
 * ONLY for whichever key is still the current target — see `accept` below.
 * An in-flight ask for a PREVIOUS target has no cancellation on the promise
 * itself (only `clearInterval`/`clearTimeout` stop FUTURE ticks, never one
 * already in flight), so a slow answer for A landing after the target has
 * already moved on to B, and already gotten its OWN fresh "not live" answer,
 * would otherwise overwrite B's correct answer with A's — leaving B stuck
 * reading `checking` with no interval running to ever ask again, because the
 * backstop itself was written to skip scheduling while checking.
 *
 * A target CHANGE reads as `checking` in the SAME render it happens, never
 * the previous key's answer for even one extra render: derived below rather
 * than set synchronously in the effect, because a target change inheriting
 * the old key's "not live" long enough for a click to land is exactly the
 * race this hook exists to close. A null key always reads as `not-live`,
 * since there is nothing to be live.
 */
export function useServiceLive(serviceKey: string | null): LiveCheck {
  const [answer, setAnswer] = useState<{ key: string | null; status: LiveStatus }>({ key: null, status: "not-live" });
  // The one true "what are we asking about right now", read at the moment an
  // async answer is about to be written — never the STALE value a `.then()`
  // closure captured back when the ask started. Written in an effect, not
  // during render: nothing here needs it to be current for THIS render, only
  // for whichever async callback reads it later, after every effect for this
  // render (including this one) has already run.
  const targetRef = useRef(serviceKey);
  useEffect(() => {
    targetRef.current = serviceKey;
  }, [serviceKey]);

  const ask = useCallback(async (key: string): Promise<LiveStatus> => {
    try {
      const res = await invoke<{ live: boolean }>("history:live", { serviceKey: key });
      return res.live ? "live" : "not-live";
    } catch (err) {
      logToServer("baptism", `could not check whether ${key} is live: ${errorMessage(err)}`);
      return "failed";
    }
  }, []);

  /** Write an answer only if `key` is still the current target — an answer
   *  for a key the target has since moved away from is not stale data worth
   *  keeping, it is the answer to a question nobody is asking anymore. */
  const accept = useCallback((key: string, next: LiveStatus) => {
    if (targetRef.current === key) setAnswer({ key, status: next });
  }, []);

  const status: LiveStatus = serviceKey == null ? "not-live" : answer.key === serviceKey ? answer.status : "checking";

  useEffect(() => {
    if (!serviceKey) return;
    let cancelled = false;
    const run = () => {
      ask(serviceKey).then((next) => {
        if (!cancelled) accept(serviceKey, next);
      });
    };
    run();
    const off = onNotification("service-timeline:history", () => {
      if (!cancelled) run();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [serviceKey, ask, accept]);

  // The slow backstop — see this hook's own comment. Cleared (not merely a
  // no-op) the moment the answer is "not live": a service that ended does
  // not spend the rest of the visit polling a question it already has the
  // answer to, on a page that stays open far longer than any one service.
  useEffect(() => {
    if (!serviceKey || status === "not-live") return;
    const id = setInterval(() => {
      ask(serviceKey).then((next) => accept(serviceKey, next));
    }, LIVE_RECHECK_MS);
    return () => clearInterval(id);
  }, [serviceKey, status, ask, accept]);

  return {
    status,
    recheck: async () => {
      if (!serviceKey) return "not-live";
      const next = await ask(serviceKey);
      accept(serviceKey, next);
      return next;
    },
    markLive: () => {
      if (serviceKey) accept(serviceKey, "live");
    },
  };
}
