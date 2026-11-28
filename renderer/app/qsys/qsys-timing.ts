// How long a Q-SYS panel page waits, in one place a test can shorten.
//
// A context with the real values as its default, rather than module variables a
// test sets and must remember to put back: a provider ends with the tree it wraps,
// so one test's timing cannot leak into the next.

import { createContext, useContext } from "react";

export interface QsysTiming {
  /** One second, as the auto-return countdown counts it. */
  secondMs: number;
  /** How long the server must have been without the Core before the offline card
   *  covers the panel. A blip shorter than this reads as Reconnecting instead. */
  coreLostAfterMs: number;
  /** How long this page must have been without Stage Utility itself (its event
   *  stream down: the server stopped, the iPad off the network) before the same card
   *  covers it. Longer than the Core's: an iPad waking takes a moment to reconnect. */
  pageLostAfterMs: number;
}

export const QSYS_TIMING: QsysTiming = { secondMs: 1000, coreLostAfterMs: 2_000, pageLostAfterMs: 10_000 };

export const QsysTimingContext = createContext<QsysTiming>(QSYS_TIMING);

export function useQsysTiming(): QsysTiming {
  return useContext(QsysTimingContext);
}
