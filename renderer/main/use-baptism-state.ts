import { useCallback } from "react";

import { invoke } from "../lib/api";
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

/** Totals + averages over the completed people in a session. */
export function summarizeBaptism(s: BaptismState | null) {
  const people = s?.people ?? [];
  const count = people.length;
  const totalTestimonyMs = people.reduce((a, p) => a + p.testimonyMs, 0);
  const totalBaptizeMs = people.reduce((a, p) => a + p.baptizeMs, 0);
  const totalMs = totalTestimonyMs + totalBaptizeMs;
  return {
    count,
    totalTestimonyMs,
    totalBaptizeMs,
    totalMs,
    avgTestimonyMs: count ? totalTestimonyMs / count : 0,
    avgBaptizeMs: count ? totalBaptizeMs / count : 0,
    avgPersonMs: count ? totalMs / count : 0,
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
