// A card's side of "is this preview live?": reading what the page inside its
// iframe says, asking when the kept Screens page comes back into view, noticing an
// iframe that loaded something that is not the preview, and telling the page it is
// hidden. The messages are preview-messages.ts.
//
// Here rather than in ViewPreview, which draws the iframe, scales it and carries
// slot drafts into it; this is the one job ViewPreview's callers that are not
// Screens cards (the View editor) never ask for.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import {
  PREVIEW_MSG,
  readPreviewMessage,
  sendPreviewMessage,
  type PreviewLiveReport,
} from "@renderer/main/preview-messages";

/** How long a kept preview has to answer "are you live?" before it is taken as not. */
export const LIVE_ASK_TIMEOUT_MS = 3000;

/**
 * Why a card has no word from its preview:
 *  - `error-page`: the iframe loaded something that is not the preview, a browser
 *    error page most often, which cannot report on itself
 *  - `load-timeout`: a new preview never said it was live (raised by the card's own
 *    timer, see lazy-preview.tsx)
 *  - `ask-timeout`: asked on the kept page's return, the page did not answer
 */
export type Silence = "error-page" | "load-timeout" | "ask-timeout";

export interface LivenessProbe {
  /** What the page says about itself. */
  onReport: (report: PreviewLiveReport) => void;
  /** The page cannot say, and why. */
  onSilent: (why: Exclude<Silence, "load-timeout">) => void;
}

/** The path an iframe's document is at, or null when it cannot be read (another origin). */
function framePath(iframe: HTMLIFrameElement | null): string | null {
  try {
    return iframe?.contentWindow?.location.pathname ?? null;
  } catch {
    return null;
  }
}

/**
 * Wire a card to its preview. Returns the iframe's `onLoad` handler. With no
 * `probe` (the View editor's preview) it does nothing.
 */
export function useLivenessProbe(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  viewId: string,
  probe: LivenessProbe | undefined,
): () => void {
  const probeRef = useLatestRef(probe);
  // Whether this iframe has a page loaded. Kept across the Screens page being
  // hidden and shown again (<Activity> keeps state and refs), which is what says
  // the iframe being shown again is a kept one, with a page to ask.
  const loadedRef = useRef(false);
  const askTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What the page says.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const m = readPreviewMessage(e, iframeRef.current?.contentWindow, viewId);
      if (m?.type !== PREVIEW_MSG.LIVE) return;
      // A page that reports has loaded, whatever its load event said.
      loadedRef.current = true;
      if (askTimerRef.current) clearTimeout(askTimerRef.current);
      askTimerRef.current = null;
      probeRef.current?.onReport({ live: m.live, since: m.since, shared: m.shared });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef, viewId, probeRef]);

  // Hidden as the kept Screens page hides, shown as it comes back: <Activity> runs
  // this cleanup as it hides the page. A layout effect, so the word goes out as the
  // page is hidden rather than some time after.
  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (loadedRef.current) sendPreviewMessage(iframe?.contentWindow, { type: PREVIEW_MSG.HIDDEN, viewId, hidden: false });
    return () => sendPreviewMessage(iframe?.contentWindow, { type: PREVIEW_MSG.HIDDEN, viewId, hidden: true });
  }, [iframeRef, viewId]);

  // Ask a kept page whether it is still live, each time this comes (back) into
  // being with a page already loaded. A fresh iframe is not asked: it reports on its
  // own once it has drawn.
  useEffect(() => {
    const target = iframeRef.current?.contentWindow;
    if (!loadedRef.current || !target || !probeRef.current) return;
    sendPreviewMessage(target, { type: PREVIEW_MSG.ASK, viewId });
    askTimerRef.current = setTimeout(() => {
      askTimerRef.current = null;
      probeRef.current?.onSilent("ask-timeout");
    }, LIVE_ASK_TIMEOUT_MS);
    return () => {
      if (askTimerRef.current) clearTimeout(askTimerRef.current);
      askTimerRef.current = null;
    };
  }, [iframeRef, viewId, probeRef]);

  return () => {
    const path = framePath(iframeRef.current);
    if (path === "blank") return; // about:blank before the real load
    loadedRef.current = true;
    // Same origin, so the preview's own address is readable; an error page's is
    // either not readable or not a preview's.
    if (!path?.startsWith("/preview-")) probeRef.current?.onSilent("error-page");
  };
}
