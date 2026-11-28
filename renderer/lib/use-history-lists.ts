// use-history-lists.ts — History's three lists, read once and kept current by
// the live pushes.
//
// History and Home's headline cards both draw from the same three reads — the
// timeline records, the attendance summaries and the SPL summary — and keep the
// first two current from the same two channels. Each page had its own copy of
// the reads and the upserts, and the copies had already drifted (one took a
// null answer as an empty list, the other installed the null).
//
// Both copies also lost a push that raced a read. A timeline push that landed
// before the first answer was dropped outright (`if (!prev) return prev`), and
// any push that landed while a read was in flight was overwritten by that
// read's older answer. Here a push received while a read is in flight is kept
// aside and laid over the answer when it comes, so the newer record wins.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { ServiceAttendanceSummary, ServiceTimeline, SplServiceSummary } from "@main/types/history";

import { invoke, onNotification } from "./api";
import { useFailedReads } from "./use-failed-reads";

export type HistoryList = "timeline" | "attendance" | "spl";

/** The list a page draws before a read answers. One shared instance, so a
 *  consumer keyed on the list's identity (useResyncOn, useMemo) does not see a
 *  new one every render. */
const NOTHING_YET: never[] = [];

/** Insert `rec`, or replace the entry with its serviceKey in place. A record the
 *  list has not seen goes first: it is the newest recording. */
export function upsertByServiceKey<T extends { serviceKey: string }>(prev: readonly T[], rec: T): T[] {
  const i = prev.findIndex((r) => r.serviceKey === rec.serviceKey);
  if (i === -1) return [rec, ...prev];
  const next = prev.slice();
  next[i] = rec;
  return next;
}

/** What a page already holds from its last visit, drawn while the reads run.
 *  A list left out (or null) has not been read yet. */
export interface HistoryListsSeed {
  timeline?: ServiceTimeline[] | null;
  attendance?: ServiceAttendanceSummary[] | null;
  spl?: SplServiceSummary[] | null;
}

export interface HistoryLists {
  /** The timeline records; null until the first read answers. */
  list: ServiceTimeline[] | null;
  setList: Dispatch<SetStateAction<ServiceTimeline[] | null>>;
  /** The attendance summaries; empty until read. */
  attList: ServiceAttendanceSummary[];
  setAttList: (update: (prev: ServiceAttendanceSummary[]) => ServiceAttendanceSummary[]) => void;
  /** The SPL summary; empty until read, and never read unless asked for. */
  splList: SplServiceSummary[];
  /** Whether each list has come back at all, well or not: an empty list cannot
   *  tell "none recorded" from "not read yet". */
  attSettled: boolean;
  splSettled: boolean;
  /** Which reads FAILED, as opposed to came back empty. Logged on `[history]`. */
  failed: ReadonlySet<HistoryList>;
  /** Read the timeline records again. A failure empties the list, as the first
   *  read's does. */
  reload: () => void;
  /** Read the attendance summaries again. A failure keeps the list as it is and
   *  says so on the log: this runs after an optimistic edit the page has
   *  already drawn, which an empty list would undo. */
  reloadAttendance: () => void;
}

/** A list read once, then upserted by the live pushes on its channel. */
function useLiveList<T extends { serviceKey: string }>(
  channel: string | null,
  seed: T[] | null | undefined,
): {
  value: T[] | null;
  set: Dispatch<SetStateAction<T[] | null>>;
  /** Start a read: pushes from now until `answer` are kept for it. */
  begin: () => number;
  /** Install a read's answer (or keep the list, for a failure that should not
   *  empty it), with every push since `begin` laid over it. False, and nothing
   *  installed, for a read a newer one superseded or that outlived the page. */
  answer: (read: number, rows: T[] | null | "keep") => boolean;
} {
  const [value, set] = useState<T[] | null>(() => seed ?? null);
  const reads = useRef(0);
  const inFlight = useRef(false);
  const pushed = useRef(new Map<string, T>());

  // A read still out when the page goes is not answered into it.
  useEffect(() => () => { reads.current += 1; }, []);

  useEffect(() => {
    if (!channel) return;
    return onNotification(channel, (p) => {
      const rec = p as T | null;
      if (!rec) return;
      if (inFlight.current) pushed.current.set(rec.serviceKey, rec);
      set((prev) => (prev ? upsertByServiceKey(prev, rec) : prev));
    });
  }, [channel]);

  const begin = useCallback(() => {
    inFlight.current = true;
    pushed.current = new Map();
    reads.current += 1;
    return reads.current;
  }, []);
  const answer = useCallback((read: number, rows: T[] | null | "keep") => {
    if (read !== reads.current) return false;
    inFlight.current = false;
    const late = [...pushed.current.values()];
    pushed.current = new Map();
    set((prev) => {
      const base = rows === "keep" ? (prev ?? []) : (rows ?? []);
      return late.reduce<T[]>((acc, rec) => upsertByServiceKey(acc, rec), base);
    });
    return true;
  }, []);
  return { value, set, begin, answer };
}

/**
 * History's lists. `spl` gates the SPL summary read: Home reads it only while a
 * card is drawing the sound line, and nobody who leaves that off should pay for
 * it. Turning it on later reads it then.
 */
export function useHistoryLists(opts: { spl: boolean; seed?: HistoryListsSeed }): HistoryLists {
  const { spl: wantSpl, seed } = opts;
  const timeline = useLiveList<ServiceTimeline>("service-timeline:history", seed?.timeline);
  const attendance = useLiveList<ServiceAttendanceSummary>("attendance:history", seed?.attendance);
  const splSummary = useLiveList<SplServiceSummary>(null, seed?.spl);
  const { failed, fail, clear } = useFailedReads<HistoryList>("history");

  const { begin: beginTl, answer: answerTl } = timeline;
  const reload = useCallback(() => {
    const read = beginTl();
    invoke<ServiceTimeline[]>("serviceTimeline:list")
      .then((l) => {
        if (answerTl(read, l)) clear("timeline");
      })
      .catch((err: unknown) => {
        if (answerTl(read, null)) fail("timeline", "the service timings", err);
      });
  }, [beginTl, answerTl, fail, clear]);

  const { begin: beginAtt, answer: answerAtt } = attendance;
  const readAttendance = useCallback(
    (onFailure: "empty" | "keep") => {
      const read = beginAtt();
      invoke<ServiceAttendanceSummary[]>("attendance:listSummaries")
        .then((a) => {
          if (answerAtt(read, a)) clear("attendance");
        })
        .catch((err: unknown) => {
          if (answerAtt(read, onFailure === "keep" ? "keep" : null)) fail("attendance", "the attendance history", err);
        });
    },
    [beginAtt, answerAtt, fail, clear],
  );
  const reloadAttendance = useCallback(() => readAttendance("keep"), [readAttendance]);

  useEffect(() => {
    reload();
    readAttendance("empty");
  }, [reload, readAttendance]);

  const { begin: beginSpl, answer: answerSpl } = splSummary;
  useEffect(() => {
    if (!wantSpl) return;
    const read = beginSpl();
    invoke<SplServiceSummary[]>("spl:getSummary")
      .then((r) => {
        if (answerSpl(read, r)) clear("spl");
      })
      .catch((err: unknown) => {
        if (answerSpl(read, null)) fail("spl", "the sound summary", err);
      });
  }, [wantSpl, beginSpl, answerSpl, fail, clear]);

  const setAtt = attendance.set;
  const setAttList = useCallback(
    (update: (prev: ServiceAttendanceSummary[]) => ServiceAttendanceSummary[]) => setAtt((prev) => update(prev ?? [])),
    [setAtt],
  );

  return {
    list: timeline.value,
    setList: timeline.set,
    attList: attendance.value ?? NOTHING_YET,
    setAttList,
    splList: splSummary.value ?? NOTHING_YET,
    attSettled: attendance.value != null,
    splSettled: splSummary.value != null,
    failed,
    reload,
    reloadAttendance,
  };
}
