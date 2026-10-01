// renderer/main/video/use-on-screen.ts — true while the element is on screen and
// the page is visible. Going false waits `teardownMs`, so scrolling past or a
// brief tab switch does not tear a session down and rebuild it.

import { useEffect, useState, type RefObject } from "react";

export function useOnScreen(ref: RefObject<Element | null>, teardownMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let intersecting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = intersecting && document.visibilityState === "visible";
      clearTimeout(timer);
      if (now) setShown(true);
      else timer = setTimeout(() => setShown(false), teardownMs);
    };
    const io = new IntersectionObserver(([e]) => { intersecting = e?.isIntersecting ?? false; update(); });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", update); clearTimeout(timer); };
  }, [ref, teardownMs]);
  return shown;
}
