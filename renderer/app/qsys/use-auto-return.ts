// Auto-return: a device that wandered from its home panel goes back on its own.
//
// The panel a device opens first is its home. A sibling opened from the cog menu
// carries `?return=<home-slug>` (qsys-cog-menu.tsx), so the way back survives a
// reload and needs no device id. While a page has a home to go back to, this
// counts down from the LAST touch, not from when the page opened: any pointer,
// touch, wheel or key event anywhere on the page starts the count again. At zero
// it navigates home, replacing the entry, and the home panel reads the Core's
// state before it takes input (use-qsys-values.ts), as any panel that opens does.
//
// The deadline is a time, not a counter decremented per tick: an iPad that slept
// throttles timers, and on waking the page must know the minutes went by. It
// checks again the moment the page is visible.
//
// `minutes` 0 never returns. The listeners are on `window` in the capture phase,
// so a fader that captures its pointer, or an object that stops propagation,
// still counts as a touch.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { qsysPanelPath } from "./qsys-paths";
import { useQsysTiming } from "./qsys-timing";

/** What counts as someone touching the screen. */
const TOUCH_EVENTS = ["pointerdown", "pointermove", "touchstart", "wheel", "keydown"] as const;

/** `seconds` as m:ss. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Count down to going home. `homeSlug` null means this page IS home (or has no
 * home to go to), and nothing counts. Answers the whole seconds left (null when
 * not counting) and `goHome`, which goes now.
 */
export function useAutoReturn(homeSlug: string | null, minutes: number): { secondsLeft: number | null; goHome: () => void } {
  const router = useRouter();
  // One second, as the countdown counts it. A test makes it a few milliseconds.
  const { secondMs } = useQsysTiming();
  const active = homeSlug !== null && minutes > 0;
  // Starts full; the first tick, a second in, says what is left. Keyed by home and
  // minutes where it is drawn (qsys-panel-route.tsx), so a new count starts full.
  const [secondsLeft, setSecondsLeft] = useState<number>(minutes * 60);

  const goHome = useCallback(() => {
    if (homeSlug !== null) void router.navigate({ to: qsysPanelPath(homeSlug), replace: true });
  }, [router, homeSlug]);

  useEffect(() => {
    if (!active) return;
    const total = minutes * 60 * secondMs;
    let lastTouch = Date.now();
    let done = false;
    const tick = () => {
      if (done) return;
      const left = lastTouch + total - Date.now();
      if (left <= 0) {
        done = true;
        goHome();
        return;
      }
      setSecondsLeft(Math.ceil(left / secondMs));
    };
    const touch = () => {
      lastTouch = Date.now();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    for (const e of TOUCH_EVENTS) window.addEventListener(e, touch, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(tick, Math.min(secondMs, 1000));
    return () => {
      done = true;
      clearInterval(timer);
      for (const e of TOUCH_EVENTS) window.removeEventListener(e, touch, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, minutes, goHome, secondMs]);

  return { secondsLeft: active ? secondsLeft : null, goHome };
}
