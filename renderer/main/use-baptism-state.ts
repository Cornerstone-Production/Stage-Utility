import { useCallback } from "react";

import { invoke } from "../lib/api";
import { reduceBaptismPeople } from "../lib/baptism-people";
import { formatClock } from "../lib/clock-format";
import { useStatusChannel } from "./use-status-channel";

/**
 * Live baptism-timer state, pushed on the "baptism:state" channel. Hydrates once
 * on mount then stays live. Shared by the operator panel and the display object.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job — see
 * the note there. A running timer whose read landed after the start frame reads
 * as stopped on the wall until the next button press.
 */
export function useBaptismState(): BaptismState | null {
  const read = useCallback(() => invoke<BaptismState>("baptism:get"), []);
  return useStatusChannel<BaptismState>(read, "baptism:state");
}

/**
 * Totals + averages over a session's people.
 *
 * `people` fills during the testimony pass in grouped mode, before anyone has
 * been baptized — an entry there means "testified", not "baptized"; its
 * `baptizeMs` sits at 0 until a baptism actually closes it (the same is true
 * of a per-person session finished early, mid-testimony). `count` — the figure
 * the panel and the layout object label "Baptized" — must not be `people.length`
 * for that reason, or three testimonies with nobody in the water yet reads as
 * three baptized. It counts entries with a real `baptizeMs`, and the averages
 * that describe a baptism (`avgBaptizeMs`, `avgPersonMs`) divide by that same
 * count, not by everyone who happened to testify.
 */
export function summarizeBaptism(s: BaptismState | null) {
  const r = reduceBaptismPeople(s?.people ?? []);
  return {
    count: r.baptized,
    totalTestimonyMs: r.totalTestimonyMs,
    totalBaptizeMs: r.totalBaptizeMs,
    totalMs: r.totalTestimonyMs + r.totalBaptizeMs,
    avgTestimonyMs: r.testified ? r.totalTestimonyMs / r.testified : 0,
    avgBaptizeMs: r.baptized ? r.totalBaptizeMs / r.baptized : 0,
    avgPersonMs: r.baptized ? r.totalBaptizedPersonMs / r.baptized : 0,
  };
}

/** ms → "m:ss" (or "h:mm:ss"). */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * "Sun, Sep 27 · 11:34 AM" — when a session (or a past one) started.
 *
 * Shared by the operator page and its header, rather than a private copy in
 * each: both name the same session, off the same field, and a second copy is
 * how the two would drift. `service-history-section.tsx` has its own
 * differently-shaped `fmtDate` (a bare calendar day, no time, for grouping past
 * services) — a different job, not a third copy of this one.
 */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " · " + formatClock(d);
}
