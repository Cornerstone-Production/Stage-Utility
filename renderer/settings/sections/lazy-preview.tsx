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

export function LazyPreview({
  viewId,
  aspect,
  onExpand,
  expandLabel,
}: {
  viewId: string;
  aspect?: number;
  /** When set, a STREAMING preview becomes a button that opens the editor.
   *  Only the streaming branch: the paused placeholder is already a button whose
   *  job is to load the preview, and nesting the two would mean a first click
   *  that expands something the operator cannot see yet. */
  onExpand?: () => void;
  expandLabel?: string;
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

  return (
    <div ref={boxRef}>
      {streaming ? (
        onExpand ? (
          // The preview IS the way in. A scrim plus a centred expand icon on
          // hover, rather than a permanently-visible affordance: the preview's
          // job is to show what the screen shows, and chrome sitting on it all
          // the time competes with that.
          <button
            type="button"
            onClick={onExpand}
            title={expandLabel}
            aria-label={expandLabel}
            className="group relative block w-full rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ViewPreview viewId={viewId} aspect={aspect} />
            <span
              className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-black/0 opacity-0 transition-all duration-(--motion-quick) group-hover:bg-black/45 group-hover:opacity-100 group-focus-visible:bg-black/45 group-focus-visible:opacity-100"
              aria-hidden="true"
            >
              {/* A SOLID neutral grey, not white at reduced opacity. Opacity made
                  it read as faded rather than as a deliberate colour — the icon
                  should look like an affordance, not like it is disappearing.
                  #d4d4d4 is strictly R=G=B, per the no-colour-cast rule for
                  anything sitting on a dark surface. */}
              <ExpandIcon className="size-7 text-[#d4d4d4]" strokeWidth={1.5} />
            </span>
          </button>
        ) : (
          <ViewPreview viewId={viewId} aspect={aspect} />
        )
      ) : (
        <button
          type="button"
          onClick={() => setForced(true)}
          className="grid aspect-video w-full place-items-center gap-1.5 rounded-lg border border-dashed border-line text-fg-subtle transition-colors hover:bg-fill hover:text-fg"
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
