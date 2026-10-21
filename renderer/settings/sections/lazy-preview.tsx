// A live preview that only holds a connection while you can see it.
//
// Each ViewPreview is an iframe running the real kiosk page, and every kiosk
// page opens a LONG-LIVED SSE stream. A browser allows roughly six concurrent
// connections per origin over HTTP/1.1, so a Screens page with eight displays
// exhausted the pool: the previews after the sixth never loaded, and the page's
// own /api/state request queued behind them and timed out. The symptom looked
// like a slow server; the cause was this page holding every connection open.
//
// Two limits fix it, and both are needed:
//   - visibility, so a preview scrolled off screen gives its connection back;
//   - a hard cap, because a large monitor can have more than six cards visible
//     at once and no amount of scrolling helps.
//
// The real fix is the SharedWorker SSE in lib/api.ts, now ON by default: every
// tab and every preview iframe on the machine shares ONE event stream, so a
// preview costs a short page load rather than a permanent connection. This file
// is the backstop for when that is unavailable — a browser without SharedWorker,
// or a worker the heartbeat had to abandon — where the old limit still bites.

import { useEffect, useRef, useState } from "react";
import { PlayIcon, ExpandIcon } from "lucide-react";
import { ViewPreview } from "./view-preview";

/**
 * How many previews may stream at once.
 *
 * Generous, because sharing one stream is what actually removes the constraint
 * and this is only the fallback. Kept finite anyway: a hundred iframes is a
 * memory and CPU problem on a Raspberry Pi long before it is a connection
 * problem, and nothing else bounds how many screens an operator can create.
 */
const MAX_LIVE_PREVIEWS = 12;

/** Ids currently streaming, and everyone waiting for a slot to free up. */
const live = new Set<symbol>();
const waiting = new Set<() => void>();

function acquire(token: symbol): boolean {
  if (live.has(token)) return true;
  if (live.size >= MAX_LIVE_PREVIEWS) return false;
  live.add(token);
  return true;
}

function release(token: symbol): void {
  if (!live.delete(token)) return;
  // Wake ONE waiter, not all of them: waking every waiter would have them all
  // claim a slot at once and blow straight back through the cap.
  const next = waiting.values().next();
  if (!next.done) {
    waiting.delete(next.value);
    next.value();
  }
}

/** Apple platforms, where Ctrl-click is a right click and Cmd is the key that opens
 *  a link in a new tab. */
function isApple(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Is this click the one a browser opens a link in a new tab with: Shift, or Cmd on
 *  a Mac and Ctrl everywhere else? (A middle click is its own event.) */
export function opensInNewTab(e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.shiftKey || (isApple() ? e.metaKey : e.ctrlKey);
}

/**
 * The keyboard-focus ring, drawn OVER the preview. An outer ring is clipped by the
 * card, and an inset one on the button paints beneath its opaque child, so
 * neither shows; this sits above the preview and is lit by the button's own focus.
 */
const FOCUS_RING = (
  <span
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-focus opacity-0 group-focus-visible:opacity-100"
  />
);

export function LazyPreview({
  viewId,
  outputId = null,
  aspect,
  onExpand,
  expandLabel,
  following,
}: {
  viewId: string;
  /** The Output this preview stands in for — passed straight through to
   *  ViewPreview, which documents what it is for. Null when the card is a View
   *  rather than a screen. */
  outputId?: string | null;
  aspect?: number;
  /** When set, a STREAMING preview becomes a button that opens the editor.
   *  Only the streaming branch: the paused placeholder is already a button whose
   *  job is to load the preview, and nesting the two would mean a first click
   *  that expands something the operator cannot see yet. */
  onExpand?: () => void;
  expandLabel?: string;
  /**
   * While the page's side panel follows the operator, the preview is not the
   * editor's door: a plain click lands on the card and moves the panel (it is
   * left to bubble there), and the editor is a small button in the corner. A
   * click with Cmd (Ctrl on Windows and Linux) or Shift, or a middle click, is not a
   * plain one and goes to `onOpenDisplay` instead, when the card has a display to
   * open.
   */
  following?: { label: string; onOpenDisplay?: () => void };
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<symbol>(Symbol("preview"));
  const [visible, setVisible] = useState(false);
  const [streaming, setStreaming] = useState(false);
  // Set when the operator asks for this one specifically, which jumps the queue
  // rather than leaving them with a placeholder they cannot resolve.
  const [forced, setForced] = useState(false);

  // Only render while on screen. rootMargin starts it slightly before it
  // arrives, so scrolling does not feel like it is waiting on you.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Claim a slot when visible; give it back when not. The cleanup is what makes
  // scrolling free connections rather than accumulate them.
  //
  // Scheduled rather than run inline: claiming may have to WAIT for a slot, so
  // it is asynchronous by nature, and setting state synchronously inside an
  // effect triggers cascading renders (the compiler lint rejects it).
  useEffect(() => {
    const token = tokenRef.current;
    let cancelled = false;

    if (!visible && !forced) {
      release(token);
      queueMicrotask(() => { if (!cancelled) setStreaming(false); });
      return () => { cancelled = true; };
    }

    const tryClaim = () => {
      if (cancelled) return;
      if (acquire(token)) queueMicrotask(() => { if (!cancelled) setStreaming(true); });
      else waiting.add(tryClaim);
    };
    queueMicrotask(tryClaim);

    return () => {
      cancelled = true;
      waiting.delete(tryClaim);
      release(token);
    };
  }, [visible, forced]);

  // Edge to edge: both callers are Screens cards, which clip to their own radius,
  // so nothing here rounds a corner or draws outside the preview.
  const preview = <ViewPreview viewId={viewId} outputId={outputId} aspect={aspect} bleed />;

  /** The live preview, wrapped for whatever the card does with a click on it. */
  function streamingPreview() {
    if (onExpand && following) {
      return (
        <div className="group relative">
          <button
            type="button"
            data-retarget
            aria-label={following.label}
            onClick={(e) => {
              // Not a plain click: the card must not also move its panel.
              if (opensInNewTab(e) && following.onOpenDisplay) {
                e.stopPropagation();
                following.onOpenDisplay();
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1 && following.onOpenDisplay) {
                e.preventDefault();
                e.stopPropagation();
                following.onOpenDisplay();
              }
            }}
            className="group relative block w-full focus:outline-none"
          >
            {preview}
            {FOCUS_RING}
          </button>
          {/* The way into the editor, as a control of its own: a click on it is
              its own and does not move the panel. */}
          <button
            type="button"
            onClick={onExpand}
            title={expandLabel}
            aria-label={expandLabel}
            className="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-md bg-black/55 text-[#d4d4d4] opacity-0 transition-opacity duration-(--motion-quick) hover:bg-black/75 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100"
          >
            <ExpandIcon className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      );
    }
    if (onExpand) {
      // The preview IS the way in. A scrim plus a centred expand icon on hover,
      // rather than a permanently-visible affordance: the preview's job is to show
      // what the screen shows, and chrome sitting on it all the time competes with
      // that.
      return (
        <button
          type="button"
          onClick={onExpand}
          title={expandLabel}
          aria-label={expandLabel}
          className="group relative block w-full focus:outline-none"
        >
          {preview}
          <span
            className="pointer-events-none absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-all duration-(--motion-quick) group-hover:bg-black/45 group-hover:opacity-100 group-focus-visible:bg-black/45 group-focus-visible:opacity-100"
            aria-hidden="true"
          >
            {/* A SOLID neutral grey, not white at reduced opacity. Opacity made
                it read as faded rather than as a deliberate colour — the icon
                should look like an affordance, not like it is disappearing.
                #d4d4d4 is strictly R=G=B, per the no-colour-cast rule for
                anything sitting on a dark surface. */}
            <ExpandIcon className="size-7 text-[#d4d4d4]" strokeWidth={1.5} />
          </span>
          {/* After the scrim, so the hover and focus wash does not dim it. */}
          {FOCUS_RING}
        </button>
      );
    }
    return preview;
  }

  return (
    <div ref={boxRef}>
      {streaming ? (
        streamingPreview()
      ) : (
        <button
          type="button"
          data-retarget
          onClick={() => setForced(true)}
          className="grid aspect-video w-full place-items-center gap-1.5 border border-dashed border-x-0 border-line text-fg-subtle transition-colors hover:bg-fill hover:text-fg"
          aria-label="Load this preview"
        >
          <PlayIcon className="size-4" />
          <span className="text-caption2">
            {visible ? "Preview paused — tap to load" : "Preview"}
          </span>
        </button>
      )}
    </div>
  );
}

/** Test seam: the cap, and the current live count. */
export const __previewLimits = {
  MAX_LIVE_PREVIEWS,
  liveCount: () => live.size,
  reset: () => {
    live.clear();
    waiting.clear();
  },
};
