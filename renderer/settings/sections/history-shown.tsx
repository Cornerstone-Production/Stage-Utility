// What History last showed, kept while the app stays open, so going back to
// History draws at once instead of waiting on its reads again.
//
// The page still reads everything on every visit and replaces what it drew
// from here when the answers land: this saves the wait, not the reads. Memory
// only, for the tab's lifetime. A reload starts empty, so an update (which
// reloads) never hands the page lists in a shape it no longer reads.
//
// A context rather than a module variable, so it lives exactly as long as the
// app that provides it. A page rendered without the provider, as every test
// that renders History alone does, keeps nothing and has nothing to leak into
// the next case.

import { createContext, useContext, useState, type ReactNode } from "react";

/** One row's sound record: the record, `null` for a service that recorded no
 *  sound, or `"error"` when the read failed. See `splByKey` in
 *  service-history-section.tsx. */
export type RowSpl = ServiceSplHistory | null | "error";

export interface HistoryShown {
  /** `null` until a read has succeeded, and again after one fails. */
  timeline: ServiceTimeline[] | null;
  attendance: ServiceAttendanceSummary[] | null;
  spl: SplServiceSummary[] | null;
  /** The rows' sound records, by service key. */
  rowSpl: ReadonlyMap<string, RowSpl>;
}

export interface HistoryKeeper {
  /** What the page showed when it last kept it. */
  readonly last: HistoryShown;
  keep: (shown: HistoryShown) => void;
}

const HistoryShownContext = createContext<HistoryKeeper | null>(null);

export function HistoryShownProvider({ children }: { children: ReactNode }) {
  const [keeper] = useState<HistoryKeeper>(() => {
    let last: HistoryShown = { timeline: null, attendance: null, spl: null, rowSpl: new Map() };
    return {
      get last() {
        return last;
      },
      keep(shown) {
        last = shown;
      },
    };
  });
  return <HistoryShownContext.Provider value={keeper}>{children}</HistoryShownContext.Provider>;
}

/** The app's kept History lists, or `null` outside the provider. */
export function useHistoryShown(): HistoryKeeper | null {
  return useContext(HistoryShownContext);
}
