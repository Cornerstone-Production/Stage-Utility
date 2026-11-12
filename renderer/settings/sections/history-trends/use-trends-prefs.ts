// The Trends card's organisation setting, shared by every browser: one read to
// hydrate, then `trends:prefs` pushes. The channel is the truth; the only thing
// this browser adds is its own newest choice, shown from the moment it is made
// until the channel has caught up with it.
//
// ── When the held choice lets go ─────────────────────────────────────────────
// The server saves, broadcasts, THEN answers, and the frame and the answer come
// back on two different connections, so either can land first. Two quick choices
// make it worse: A's echo arrives while B is still out. So:
//
//   - only the newest choice is held; an answer to an older one is ignored
//   - no frame lets go of it while its request is out: A's echo is not B's
//   - a refusal lets go at once, and the select shows the server's value
//   - once answered, it lets go when the channel reaches the answer's rev (the
//     echo, or another browser's later change), or when a frame that arrived
//     after the choice carries the held metric
//
// The second test is for a restart. The server's rev starts again at 0 with
// every process, so a rev compared across one would hold the choice until the
// counter climbed back; a restarted server's first frame carries the saved
// choice, which is this one, and that lets go. It must be a NEW frame: pick B
// and then A again over a saved A, and the A already on screen is not the echo
// of the second pick; letting go on it shows B's echo when it lands.

import { useCallback, useRef, useState } from "react";

import { invoke } from "../../../lib/api";
import { useStatusChannel } from "../../../main/use-status-channel";
import { TRENDS_PREFS_CHANNEL, type TrendsPrefsState } from "@main/types/trends-prefs";

export interface TrendsPrefsHandle {
  /** The saved sound metric, or null when nobody has chosen. Shows this
   *  browser's own newest pick the moment it is made. */
  soundMetric: string | null;
  /** Whether the saved choice has been heard yet (a read or a push, success or
   *  failure). Until then `soundMetric` null means "not known", not "unset". */
  known: boolean;
  /** Save a choice. Rejects with the server's reason, and the select goes back
   *  to the server's value; the caller says it. */
  chooseSoundMetric: (metric: string) => Promise<void>;
}

interface Held {
  metric: string;
  /** Which choice this is; an answer to any other is ignored. */
  turn: number;
  /** The rev the server answered with, once it has. */
  answeredRev: number | null;
  /** The channel frame on screen when the choice was first rendered;
   *  undefined until then. */
  base?: TrendsPrefsState | null;
}

export function useTrendsPrefs(): TrendsPrefsHandle {
  const read = useCallback(() => invoke<TrendsPrefsState>("history:getTrendsPrefs"), []);
  const channel = useStatusChannel<TrendsPrefsState>(read, TRENDS_PREFS_CHANNEL, true);
  const [held, setHeld] = useState<Held | null>(null);
  const turns = useRef(0);

  // Let go in render, so a frame that settles it never paints the held value
  // once more on its way out.
  const frame = channel.value;
  if (held?.base === undefined) {
    if (held) setHeld({ ...held, base: frame });
  } else if (
    held.answeredRev !== null &&
    frame &&
    // A new frame from the same process always carries a higher rev than the
    // one on screen when the choice was made. One at or below it comes from a
    // restarted server, whatever value it holds, so the echo is not coming.
    (frame.rev >= held.answeredRev || (held.base != null && frame !== held.base && frame.rev <= held.base.rev))
  ) {
    setHeld(null);
  }

  const chooseSoundMetric = useCallback(async (metric: string) => {
    const turn = ++turns.current;
    setHeld({ metric, turn, answeredRev: null });
    let answer: TrendsPrefsState;
    try {
      answer = await invoke<TrendsPrefsState>("history:setTrendsPrefs", { soundMetric: metric });
    } catch (err) {
      setHeld((h) => (h?.turn === turn ? null : h));
      throw err;
    }
    setHeld((h) => (h?.turn === turn ? { ...h, answeredRev: answer.rev } : h));
  }, []);

  return {
    soundMetric: held ? held.metric : (channel.value?.soundMetric ?? null),
    known: channel.known,
    chooseSoundMetric,
  };
}
