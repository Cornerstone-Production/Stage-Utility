import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Live baptism-timer state, pushed on the "baptism:state" channel. Hydrates once
 * on mount then stays live. Shared by the operator panel and the display object.
 */
export function useBaptismState(): BaptismState | null {
  const [state, setState] = useState<BaptismState | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<BaptismState>("baptism:get")
      .then((s) => {
        if (!cancelled && s) setState(s);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onNotification("baptism:state", (p) => setState(p as BaptismState)), []);

  return state;
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
