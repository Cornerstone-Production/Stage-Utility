// The messages a preview iframe and the page around it send each other.
//
// A preview is the real kiosk page, `/preview-<viewId>`, in an iframe on a Screens
// card or in the View editor. Five messages cross that boundary, all same-origin:
//
//   draft   card → page   unsaved slot edits to draw instead of the saved ones
//   ready   page → card   its listener is up, so the card (re)sends the draft
//   live    page → card   whether it is live: drawn with a state, its event stream
//                         delivering, and whether that stream is the shared one
//   ask     card → page   "are you live?", answered with `live`
//   hidden  card → page   the kept Screens page was hidden (true) or shown (false)
//
// Why `live`, `ask` and `hidden` exist. The card cannot see into the picture: the
// iframe's `load` fires for a browser error page too, and before the page has any
// state to draw. Once the Screens page is kept while the operator is away
// (kept-screens.tsx), a picture can sit there for minutes, and if its stream
// dropped meanwhile the frozen frame would pass for live. A hidden page's
// listeners are gone (<Activity> destroys Effects), so a report sent while the
// operator was away is lost, and on return the card asks. And a preview cannot
// always tell it has been hidden: Chromium and WebKit report its content off
// screen to an IntersectionObserver inside it, Firefox does not (driven in all
// three), so a Video widget playing in a preview would pull its feed for the whole
// keep unless told.
//
// One module for both ends, so the writer and the reader cannot drift, and ONE
// read guard, so every listener checks origin, sender and view the same way.

import { useEffect, useState } from "react";
import { previewViewIdFromSlug } from "./preview-url";

const DRAFT = "stage-utility:preview-draft";
const READY = "stage-utility:preview-ready";
const LIVE = "stage-utility:preview-live";
const ASK = "stage-utility:preview-live?";
const HIDDEN = "stage-utility:preview-hidden";

export type PreviewMessage =
  | { type: typeof DRAFT; viewId: string; slots: Slot[] | null }
  | { type: typeof READY; viewId: string }
  | { type: typeof LIVE; viewId: string; live: boolean; since: number | null; shared: boolean }
  | { type: typeof ASK; viewId: string }
  | { type: typeof HIDDEN; viewId: string; hidden: boolean };

/** The message types, for a `switch` on a message read with readPreviewMessage. */
export const PREVIEW_MSG = { DRAFT, READY, LIVE, ASK, HIDDEN } as const;

/** What a preview page says about itself in a `live` message. */
export type PreviewLiveReport = Pick<Extract<PreviewMessage, { type: typeof LIVE }>, "live" | "since" | "shared">;

/** Send `message` to `to` (an iframe's window, or a page's parent), same-origin only. */
export function sendPreviewMessage(to: Window | null | undefined, message: PreviewMessage): void {
  to?.postMessage(message, window.location.origin);
}

/**
 * The message `e` carries, if it is one of these, from `from`, about `viewId`
 * (any view, when none is named); otherwise null. `from` is the one window allowed
 * to send it: the card's own iframe, or the page's own parent. Two cards can show
 * one view, so the view id alone does not say which iframe spoke.
 */
export function readPreviewMessage(e: MessageEvent, from: Window | null | undefined, wanted?: string): PreviewMessage | null {
  if (e.origin !== window.location.origin || !from || e.source !== from) return null;
  const d = e.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || typeof d.viewId !== "string") return null;
  if (wanted !== undefined && d.viewId !== wanted) return null;
  const viewId = d.viewId;
  switch (d.type) {
    case DRAFT:
      return { type: DRAFT, viewId, slots: Array.isArray(d.slots) ? (d.slots as Slot[]) : null };
    case READY:
      return { type: READY, viewId };
    case LIVE:
      if (typeof d.live !== "boolean") return null;
      return {
        type: LIVE,
        viewId,
        live: d.live,
        since: typeof d.since === "number" ? d.since : null,
        shared: d.shared !== false,
      };
    case ASK:
      return { type: ASK, viewId };
    case HIDDEN:
      return typeof d.hidden === "boolean" ? { type: HIDDEN, viewId, hidden: d.hidden } : null;
    default:
      return null;
  }
}

/** The view this page previews, from its own address, or null on a real display. */
function ownPreviewViewId(): string | null {
  let slug = window.location.pathname.slice(1);
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // A malformed escape: read the slug as it is.
  }
  return previewViewIdFromSlug(slug);
}

/**
 * Inside a preview page: whether its card has hidden it with the kept Screens page.
 * Always false on a real display.
 */
export function usePreviewHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const viewId = ownPreviewViewId();
    if (!viewId) return;
    function onMessage(e: MessageEvent) {
      const m = readPreviewMessage(e, window.parent, viewId!);
      if (m?.type === HIDDEN) setHidden(m.hidden);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return hidden;
}
