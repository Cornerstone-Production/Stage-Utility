import { useEffect, useRef, useState } from "react";

import { onNotification } from "../lib/api";

/**
 * Hydrate a change-driven status channel and keep it live, without the older
 * read ever overwriting a newer push.
 *
 * ── The bug this exists for ────────────────────────────────────────────────
 * Every integration status hook did the same two things: read the current value
 * once, and subscribe to a channel that broadcasts ONLY on change. If a push
 * landed before the read resolved, the read's `setState` ran last and put the
 * older value back. Nothing corrects it, because the next frame does not arrive
 * until something else changes — in a quiet building, hours. OBS is where it was
 * noticed; the shape was in seven hooks.
 *
 * ── Why not "ignore the read once a push has arrived" ──────────────────────
 * Because a push always arrives. `renderer/lib/api.ts` caches the last frame of
 * each hydrated channel and replays it to every late subscriber in a microtask,
 * so any component mounting into an already-open stream is handed the
 * CONNECT-TIME value immediately — which is exactly the stale value the read
 * exists to correct. That flag trades a rare race for a guaranteed regression on
 * every mount after the first.
 *
 * ── What it does instead ───────────────────────────────────────────────────
 * The server stamps a monotonic `rev` on both halves, bumped only when a frame
 * really goes out (see `RevisionedStatus` in main/types/live.ts). Pushes always
 * apply — they arrive in order on one stream, and applying them unconditionally
 * is also what lets a client recover when the server restarts and the counter
 * goes back to 0. The read applies unless it is STRICTLY older than a push
 * already applied:
 *
 *   - push rev 6 beat the read at rev 5  → read dropped, the push stands
 *   - replayed connect-time rev 3, read rev 7 → read applies, staleness fixed
 *   - equal revs → the read applies, and is at worst identical; Smaart keeps its
 *     snapshot current between throttled broadcasts, so at the same rev the read
 *     can legitimately be the fresher of the two
 *
 * A payload with no `rev` (an older server) skips the comparison entirely and
 * behaves exactly as this code did before.
 *
 * @param read  issues the one-shot hydrate. A thunk rather than a channel name,
 *              so the invoke call and its quoted channel stay written out at the
 *              call site: api-channels.test.ts matches that call shape and cannot
 *              see a channel handed through a variable. (Do not write an example
 *              of the shape here — a channel named only by prose satisfying that
 *              scan is a trap this repo has already fallen into once.)
 * @param pushChannel  SSE channel carrying the live frames.
 */
export function useStatusChannel<T extends { rev?: number }>(
  read: () => Promise<T | null | undefined>,
  pushChannel: string,
  enabled = true,
): T | null {
  const [value, setValue] = useState<T | null>(null);

  // Highest rev applied from a push during THIS hydration window.
  const pushedRev = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // A fresh window: a rev left over from a previous `enabled` cycle, or from a
    // server that has since restarted its counter, must not block this read.
    pushedRev.current = null;
    let cancelled = false;

    // Subscribe FIRST, so a push that lands while the read is in flight is seen
    // rather than silently lost between the two.
    const off = onNotification(pushChannel, (p) => {
      const frame = p as T;
      const rev = frame?.rev;
      if (typeof rev === "number") pushedRev.current = Math.max(pushedRev.current ?? rev, rev);
      setValue(frame);
    });

    read()
      .then((s) => {
        if (cancelled || !s) return;
        const seen = pushedRev.current;
        if (seen !== null && typeof s.rev === "number" && s.rev < seen) return;
        setValue(s);
      })
      .catch(() => {
        // Not configured yet, or the integration is down — the same swallow the
        // seven call sites this replaces each carried, kept in ONE place rather
        // than seven. There is no caller to hand the failure to: this read is
        // only the first paint before the live channel takes over, and the
        // channel remains the source of truth either way. A hard failure worth
        // an operator's attention surfaces on the Integrations page, which
        // reports connection state separately.
      });

    return () => {
      cancelled = true;
      off();
    };
    // `read` is a dependency, so every caller memoises it (all seven do, with
    // useCallback). An unmemoised one would re-subscribe and re-hydrate on every
    // render — wasteful, but not wrong: the ordering rule still holds, because a
    // fresh window resets the counter above.
  }, [enabled, pushChannel, read]);

  return value;
}
