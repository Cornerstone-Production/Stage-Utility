// The Screens page, kept mounted while the operator is elsewhere.
//
// Every card on Screens is a live preview: an iframe running the real kiosk page.
// Rendered through the router's <Outlet/>, leaving the page unmounted every one of
// them, so coming back from Home rebooted up to twelve kiosk pages at once and each
// card sat black until its page had loaded again.
//
// Here the page is drawn by the shell instead (ShellOutlet, below), inside
// <Activity>. Leaving hides it (`display: none`) rather than removing it: React
// keeps its DOM and state and destroys its Effects, and a browser does not reload an
// iframe it only hides (driven in Chromium, Firefox and WebKit). Coming back shows
// the same iframes, already live, with no reload and no fade, scrolled to where the
// operator left it, so the cards that were in view are the ones still live.
//
// Kept for KEEP_MS after the operator leaves, then dropped, so the next visit is a
// cold one. The timer starts on leave, is cancelled on return, and starts again on
// the next leave.
//
// ONLY ON THE SHARED STREAM. While every page and preview reads events through the
// one SharedWorker stream, a hidden preview holds no connection. Off it (a browser
// without SharedWorker, the opt-out, the poll transport, or a worker the heartbeat
// abandoned) each preview holds its own EventSource, and twelve of them kept while
// the operator is on Home is the starvation lazy-preview.tsx exists to prevent. So
// off the shared stream leaving drops the page as it always did, and losing the
// stream while away drops a kept page at once. That goes for each preview's own
// stream too: every preview iframe runs its own copy of the app, with its own
// worker heartbeat, and says in its live report whether it is on the shared stream
// (preview-messages.ts). This listens for that even while the page is hidden, since
// it sits outside the <Activity>.

import { Activity, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Outlet, useRouter } from "@tanstack/react-router";
import { ErrorBoundary } from "../../components/ui/error-boundary-view";
import { onSharedStreamChange, sharedStreamInUse, sharedStreamOffReason } from "../../lib/api";
import { logToServer } from "../../lib/client-log";
import { PREVIEW_MSG, readPreviewMessage } from "../../main/preview-messages";
import { PAGE_SCROLLER_SELECTOR } from "../route-reset";
import { ScreensRoute } from "./screens-route";

/** How long the page is kept after the operator leaves it. */
export const KEEP_MS = 10 * 60_000;

/** Why the page was dropped when a preview, not this page, left the shared stream. */
const PREVIEW_OFF_SHARED = "a preview is off the shared event stream";

/**
 * Whether `pathname` is the Screens page. The router serves `/screens/` as the
 * same page and reports the pathname with its slash, so one trailing slash is
 * forgiven, as active-page.ts forgives it.
 */
export function isScreensPath(pathname: string): boolean {
  return pathname === "/screens" || pathname === "/screens/";
}

/**
 * The router's component for `/screens`. Draws nothing: the shell draws the page,
 * through ShellOutlet, so that it can outlive the route.
 */
export function ScreensRouteSlot() {
  return null;
}

/**
 * What the shell draws in its page pane: the route's own content, and beside it the
 * kept Screens page. One component so a test can render exactly what the shell
 * does. `screens` stands in for the Screens page in a test.
 */
export function ShellOutlet({
  pathname,
  resetKey,
  screens = <ScreensRoute />,
}: {
  pathname: string;
  resetKey: number;
  screens?: ReactNode;
}) {
  return (
    <>
      {/* Keyed so re-selecting the active rail item remounts the route,
          returning it to its top view. */}
      <div key={resetKey} className="contents">
        <Outlet />
      </div>
      <KeptScreens pathname={pathname} resetKey={resetKey}>
        {screens}
      </KeptScreens>
    </>
  );
}

/** Reasons already logged on this page load: one line per reason, not one per leave. */
const loggedOff = new Set<string>();

/** The app's one scrolling pane, the shell's <main>. */
function pagePane(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PAGE_SCROLLER_SELECTOR);
}

/**
 * The kept Screens page, `children`. Rendered on every route, beside the router's
 * <Outlet/>.
 *
 * `resetKey` is the shell's re-select nonce (route-reset.ts). Re-selecting Screens
 * while on it rebuilds the page, as it rebuilds any route; a re-select of another
 * page while Screens is hidden leaves it alone.
 */
export function KeptScreens({ pathname, resetKey, children }: { pathname: string; resetKey: number; children: ReactNode }) {
  const here = isScreensPath(pathname);
  const shared = useSyncExternalStore(onSharedStreamChange, sharedStreamInUse, sharedStreamInUse);
  const pageRef = useRef<HTMLDivElement>(null);
  // Set while any preview's own live report says it is off the shared stream:
  // which previews, so one that falls off and comes back does not drop the keep
  // on every later leave.
  const [previewOff, setPreviewOff] = useState(false);
  const offPreviews = useRef(new Set<Window>());

  // Whether the page exists at all: from a visit until the keep runs out, or until
  // there is no shared stream to keep it on.
  const [kept, setKept] = useState(here);
  const [dropped, setDropped] = useState<string | null>(null);
  if (here && !kept) setKept(true);
  if (!here && kept && (!shared || previewOff)) {
    setKept(false);
    setPreviewOff(false);
    setDropped(shared ? PREVIEW_OFF_SHARED : (sharedStreamOffReason() ?? "the shared event stream is not in use"));
  }

  // Rebuilt on a re-select while visible, and only then.
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  const [generation, setGeneration] = useState(0);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    if (here) setGeneration((g) => g + 1);
  }

  // The keep timer: started on leave, cancelled on return.
  useEffect(() => {
    if (here || !kept) return;
    const timer = setTimeout(() => setKept(false), KEEP_MS);
    return () => clearTimeout(timer);
  }, [here, kept]);

  // A preview that says it is off the shared stream. Heard while the page is hidden
  // too: this listener is outside the <Activity>, so hiding does not take it down.
  useEffect(() => {
    if (!kept) return;
    // A page kept afresh starts with no preview off the shared stream.
    offPreviews.current.clear();
    function onMessage(e: MessageEvent) {
      const frames = pageRef.current?.querySelectorAll("iframe") ?? [];
      const from = [...frames].map((f) => f.contentWindow).find((w) => w !== null && w === e.source);
      const m = readPreviewMessage(e, from);
      if (m?.type !== PREVIEW_MSG.LIVE || !from) return;
      if (m.shared) offPreviews.current.delete(from);
      else offPreviews.current.add(from);
      setPreviewOff(offPreviews.current.size > 0);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [kept]);

  // Where the operator was scrolled, so coming back puts the same cards in view and
  // they stay live: the router sends every forward navigation to the top
  // (router.tsx), and the cards that would then be out of view give their previews
  // up. Read while the page shows; a scroll after it is hidden is the pane clamping
  // to a shorter page, not the operator.
  const savedScroll = useRef<number | null>(null);
  useEffect(() => {
    const pane = pagePane();
    if (!here || !pane) return;
    const save = () => {
      const page = pageRef.current;
      if (page && getComputedStyle(page).display !== "none") savedScroll.current = pane.scrollTop;
    };
    save();
    pane.addEventListener("scroll", save, { passive: true });
    return () => pane.removeEventListener("scroll", save);
  }, [here]);
  // A dropped page comes back cold, at the top.
  useEffect(() => {
    if (!kept) savedScroll.current = null;
  }, [kept]);
  // Put it back before the browser paints the page shown again, so no card's
  // observer sees the top of the page first. And again once the router has done its
  // own reset to the top, which comes after.
  const restoreTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!here || savedScroll.current === null) return;
    restoreTo.current = savedScroll.current;
    const pane = pagePane();
    if (pane) pane.scrollTop = restoreTo.current;
  }, [here]);
  const router = useRouter({ warn: false });
  useEffect(() => {
    if (!router) return;
    return router.subscribe("onRendered", (event) => {
      const to = restoreTo.current;
      restoreTo.current = null;
      const pane = pagePane();
      if (to !== null && pane && isScreensPath(event.toLocation.pathname)) pane.scrollTop = to;
    });
  }, [router]);

  // A decision an operator may need on a Sunday morning: why coming back to Screens
  // reloaded every preview on this machine. Once per reason per page load.
  useEffect(() => {
    if (!dropped || loggedOff.has(dropped)) return;
    loggedOff.add(dropped);
    logToServer("preview", `not keeping the Screens previews while away: ${dropped}`);
  }, [dropped]);

  if (!kept) return null;
  return (
    <Activity mode={here ? "visible" : "hidden"}>
      {/* <Activity> detaches refs as it hides, and the listener and the scroll
          check below want this element exactly then, so a hide's null is ignored. */}
      <div
        ref={(el) => {
          if (el) pageRef.current = el;
        }}
      >
        <ErrorBoundary key={generation}>{children}</ErrorBoundary>
      </div>
    </Activity>
  );
}

/** Test seam: forget which reasons were logged, so a case starts from a fresh page load. */
export const __keptScreens = {
  reset: () => loggedOff.clear(),
};
