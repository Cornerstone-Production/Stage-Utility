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
 * so any component mounting into an already-open stream is handed a CACHED value
 * immediately — and the server filters a channel out for a client with nothing
 * subscribed to it, so once the last subscriber goes away that cache stops being
 * updated and can be hours old. Correcting exactly that is what the read is for.
 * A bare "a push has arrived" flag trades a rare race for a guaranteed regression
 * on every mount after the first.
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
 * ── Channels that cannot carry a rev ─────────────────────────────────
 * Not every change-driven channel is a StatusIntegration. OSC feedback, the
 * baptism timer, wireless telemetry, the transcript buffer and the integration
 * list are pushed by other machinery and stamp nothing, and the same race is the
 * same bug there — an OSC button showing the wrong lamp until somebody touches
 * the desk again.
 *
 * With no revs to compare, the only fact left is WHICH FRAME IS A REPLAY.
 * `onNotification` says so, and the answer is exactly what a rev would tell us:
 * a LIVE frame is something the server sent after this read went out, so it
 * wins; a REPLAYED frame is the cached snapshot the read exists to correct, so
 * it does not. That is the identity used above, without the counter.
 *
 * A replayed frame still APPLIES — first paint from a cache beats an empty
 * widget, and it is the reason the cache exists. It just does not veto the read.
 *
 * @param read  issues the one-shot hydrate. A thunk rather than a channel name,
 *              so the invoke call and its quoted channel stay written out at the
 *              call site: api-channels.test.ts matches that call shape and cannot
 *              see a channel handed through a variable. (Do not write an example
 *              of the shape here — a channel named only by prose satisfying that
 *              scan is a trap this repo has already fallen into once.)
 * @param pushChannel  SSE channel carrying the live frames.
 * @param options.clearOnReadFailure  drop back to null when the hydrate fails,
 *   instead of keeping whatever was already there. OFF by default, which is what
 *   every integration status wants: a value that was true a moment ago is better
 *   than a blank readout, and the live channel will correct it. ON for a set that
 *   is a CLAIM ABOUT THE PRESENT — display presence is the one, where keeping the
 *   old set across an `enabled` false→true flip reports screens as Connected on
 *   the strength of a read that just failed. Empty is the honest reading of "we
 *   do not know" there, and it fails toward "go and look at the screen".
 */
/**
 * The frame's `rev`, or null when it carries none.
 *
 * Read off the value rather than declared in the type parameter: the constraint
 * that said so was `{ rev?: number }`, which is a WEAK TYPE — every property
 * optional — so TypeScript rejects any payload with no property in common with
 * it, which is every rev-less channel and every array-shaped one. The rule is a
 * fact about the payload at run time, so it is checked at run time.
 */
function revOf(frame: unknown): number | null {
  const rev = (frame as { rev?: unknown } | null)?.rev;
  return typeof rev === "number" ? rev : null;
}

export function useStatusChannel<T extends object>(
  read: () => Promise<T | null | undefined>,
  pushChannel: string,
  enabled = true,
  options: { clearOnReadFailure?: boolean } = {},
): T | null {
  // Destructured, not carried as an object: an options literal is a new object
  // every render, and as an effect dependency that re-subscribes and re-hydrates
  // on every one.
  const clearOnReadFailure = options.clearOnReadFailure ?? false;
  const [value, setValue] = useState<T | null>(null);

  // Highest rev applied from a push during THIS hydration window.
  const pushedRev = useRef<number | null>(null);
  // Whether a LIVE frame (not a replayed cache snapshot) landed in this window.
  // The rev-less stand-in for `pushedRev` — see the header.
  const pushedLive = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    // A fresh window: a rev left over from a previous `enabled` cycle, or from a
    // server that has since restarted its counter, must not block this read.
    pushedRev.current = null;
    pushedLive.current = false;
    let cancelled = false;

    // Subscribe FIRST, so a push that lands while the read is in flight is seen
    // rather than silently lost between the two.
    const off = onNotification(pushChannel, (p, replayed) => {
      const frame = p as T;
      const rev = revOf(frame);
      if (rev !== null) pushedRev.current = Math.max(pushedRev.current ?? rev, rev);
      if (!replayed) pushedLive.current = true;
      setValue(frame);
    });

    read()
      .then((s) => {
        if (cancelled || !s) return;
        const seen = pushedRev.current;
        const mine = revOf(s);
        // Revs on both sides: the counter decides, and only STRICTLY older loses.
        if (seen !== null && mine !== null) {
          if (mine < seen) return;
        } else if (pushedLive.current) {
          // No revs to compare. A live frame went out after this read did, so it
          // is the newer of the two; a replay would not have set this.
          return;
        }
        setValue(s);
      })
      .catch((err: unknown) => {
        // ── What a caller can and cannot learn from this ────────────────────
        //
        // Not much, on purpose. This hook returns `T | null`, so "not configured
        // yet", "the integration is down" and "the read fails on every mount"
        // are one value — and unlike useStageState, which was given an `error`
        // field in the same work, that is the right shape HERE. The read is only
        // the first paint before the live channel takes over; the channel stays
        // the source of truth either way; and the place that reports a
        // connection problem an operator can act on is the Integrations page,
        // which asks the server directly rather than inferring it from a widget.
        // An `error` on every one of the nine status hooks would be a field with
        // no reader, and a widget saying "OBS unreachable" in a wall tile is the
        // second, quieter answer to a question that page already answers loudly.
        //
        // What was genuinely missing is any trace at all. Nine hooks swallowed
        // nine failures in silence, so an integration widget that never filled
        // in left nothing behind to read. It is logged now, tagged and naming
        // the channel, the same way useStageState logs its hydrate — that is the
        // 9am-on-a-Sunday answer, and it costs no caller anything.
        //
        // If a surface ever does need to tell the three apart, the change is to
        // return `{ value, error }` and let useStatusChannel keep the plain
        // shape as a wrapper — not to add a tenth hand-rolled hydrate.
        if (cancelled) return;
        console.warn(`[status-channel] hydrate failed for ${pushChannel}`, err);
        if (clearOnReadFailure) setValue(null);
      });

    return () => {
      cancelled = true;
      off();
    };
    // `read` is a dependency, so every caller memoises it (all seven do, with
    // useCallback). An unmemoised one would re-subscribe and re-hydrate on every
    // render — wasteful, but not wrong: the ordering rule still holds, because a
    // fresh window resets the counter above.
  }, [enabled, pushChannel, read, clearOnReadFailure]);

  return value;
}
