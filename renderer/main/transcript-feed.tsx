import { memo, useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { cn } from "../lib/cn";
import { lineColor } from "./channel-color";

interface TranscriptFeedProps {
  lines: TranscriptLineDTO[];
  /** Cap to the last N lines (compact layout object). Omit to show all (full view). */
  maxLines?: number;
  /** Allow the viewer to scroll history; follows the newest line until they
   *  scroll up, and again once they scroll back to the bottom (full
   *  transcription view). Default false (compact object — no scrollbar). */
  scrollable?: boolean;
  /** Show the small speaker/channel label prefix. Defaults to auto (on if any
   *  line carries a channel/name). */
  showLabels?: boolean;
  /** User-assigned colors keyed by channel label; overrides the auto color. */
  colorOverrides?: Record<string, string> | null;
  /** Use ProdCom's own per-channel color when a channel has no custom pick.
   *  Default false — see resolveChannelColor() in channel-color.ts. */
  followProdcom?: boolean;
  /** Base text style applied to the container so font size/family/align cascade
   *  to every line (used by the layout object, sized to its box). */
  textStyle?: CSSProperties;
  /** Per-line className (e.g. the full view's responsive clamp size). */
  lineClassName?: string;
  /** Gap between lines. Default "gap-3" for the full view; em-based for objects. */
  gapClassName?: string;
  /** Placeholder when there are no lines (full view). Omit for none. */
  emptyText?: string | null;
  className?: string;
}

interface TranscriptLineRowProps {
  line: TranscriptLineDTO;
  labels: boolean;
  colorOverrides?: Record<string, string> | null;
  followProdcom: boolean;
  lineClassName?: string;
}

/** Shallow value comparison for a flat `Record<string, string>` prop.
 *
 *  Every `prodcom:transcript` push and every `stage:state-changed` broadcast is a
 *  fresh `JSON.parse` of a wire payload, so `colorOverrides` is a new object on
 *  every push even when nobody touched a caption color — comparing it with `===`
 *  would defeat the memo below for every line, on every push, forever. */
function sameColorOverrides(
  a: Record<string, string> | null | undefined,
  b: Record<string, string> | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

/** Test-only: how many times a row's render body actually ran since the last
 *  reset. jsdom cannot observe a memo bail-out any other way — there is no DOM
 *  signal for "this row's render was skipped", only for "the DOM changed", and a
 *  row can re-render and still leave the DOM untouched. */
let rowRenderCountForTests = 0;
export function __rowRenderCountForTests(): number {
  return rowRenderCountForTests;
}
export function __resetRowRenderCountForTests(): void {
  rowRenderCountForTests = 0;
}

/** One transcript line, memoized so a push where only a few lines actually
 *  changed re-renders only those lines rather than the whole visible window.
 *
 *  Compared by VALUE. Every consumer parses a fresh JSON payload per push
 *  (`sse-shared-worker.ts`), so `line` and `colorOverrides` are never
 *  referentially equal to the previous push's even when their content is
 *  identical — an identity comparator would silently never skip a render. */
const TranscriptLineRow = memo(
  function TranscriptLineRow({ line, labels, colorOverrides, followProdcom, lineClassName }: TranscriptLineRowProps) {
    rowRenderCountForTests++;
    return (
      <p
        className={cn("leading-snug", lineClassName)}
        style={{ color: lineColor(line, colorOverrides, followProdcom), opacity: line.isFinal ? 1 : 0.55 }}
      >
        {labels && (line.channelName || line.channel) && (
          <span className="text-[0.5em] font-medium uppercase tracking-wider text-fg-subtle mr-[0.6em] align-middle">
            {line.channelName ?? line.channel}
          </span>
        )}
        {line.text}
      </p>
    );
  },
  (prev, next) =>
    // Every field the render above reads, including everything `lineColor()`
    // depends on (line.color, line.channel, line.channelName, colorOverrides,
    // followProdcom). `id`, `text`, `isFinal`, `channel`, `channelName`, `color`
    // and `redactions` are all primitives on TranscriptLineDTO
    // (main/types/views.ts) — `===` is already a value comparison for each.
    // `colorOverrides` is the one object field and gets its own value
    // comparator above; `followProdcom` and `labels` are primitives too.
    prev.line.id === next.line.id &&
    prev.line.text === next.line.text &&
    prev.line.isFinal === next.line.isFinal &&
    prev.line.channel === next.line.channel &&
    prev.line.channelName === next.line.channelName &&
    prev.line.color === next.line.color &&
    prev.line.redactions === next.line.redactions &&
    prev.labels === next.labels &&
    prev.followProdcom === next.followProdcom &&
    prev.lineClassName === next.lineClassName &&
    sameColorOverrides(prev.colorOverrides, next.colorOverrides),
);

/** How close to the bottom counts as AT the bottom, for turning following back
 *  on. A scroll to the end lands exactly on it; this only absorbs the
 *  fractional scrollTop a zoomed page can report. */
const AT_BOTTOM_PX = 4;

type Box<T> = { current: T };

/** Record the viewer's intent, and let scroll anchoring act only while they
 *  read back (see useFollowNewest). */
function setFollowing(el: HTMLElement, following: Box<boolean>, on: boolean): void {
  following.current = on;
  el.style.overflowAnchor = on ? "none" : "";
}

/** Within AT_BOTTOM_PX of the end. */
function atBottom(el: HTMLElement, top: number): boolean {
  return el.scrollHeight - top - el.clientHeight <= AT_BOTTOM_PX;
}

/**
 * Scroll to the very bottom, and remember where that left scrollTop so the next
 * scroll event is not read as the viewer scrolling up.
 *
 * Unless the viewer has already scrolled up: scrollTop sits above where the last
 * pin left it and short of the bottom, but the scroll event saying so has not been
 * delivered yet. Pinning then would pull them back down mid-gesture, so following
 * ends here instead. Nothing but the viewer moves it up there: anchoring is off
 * while following, and a browser's clamp when the content shrinks lands at the
 * bottom. Any means counts (a wheel, a key, a scrollbar drag, touch momentum after
 * the finger lifts), so no input event is needed, and input that moved nothing
 * leaves the feed following.
 */
function pinOrRelease(el: HTMLElement, following: Box<boolean>, lastTop: Box<number>): void {
  if (!following.current) return;
  const top = el.scrollTop;
  if (top < lastTop.current && !atBottom(el, top)) {
    setFollowing(el, following, false);
    lastTop.current = top;
    return;
  }
  el.scrollTop = el.scrollHeight;
  lastTop.current = el.scrollTop;
}

/**
 * Keep a scroller on its newest content while the viewer wants that, and leave
 * them where they are once they have scrolled up to read back.
 *
 * "Following" is the VIEWER'S intent, so only the viewer changes it. It turns
 * off when a scroll moves up that this hook did not make, and back on when a
 * scroll lands at the bottom. Nothing this hook does, and no line arriving or
 * leaving, can turn it off.
 *
 * It used to be recomputed from layout on every scroll event. Under real
 * caption traffic a scroll event often reaches the page after another push has
 * been committed and before the follow ran: it read the new, taller content as
 * "scrolled away from the bottom", following turned off, and the page stopped
 * on an old line for good.
 *
 * Following pins in a LAYOUT effect, so the pin lands in the same task as the
 * commit, before paint and before any scroll event can read the new content
 * unfollowed. A line that wraps taller without a new line arriving (a font
 * loading, the box resizing) is followed by the ResizeObserver.
 *
 * Scroll anchoring is off while following and on while reading back. Once the
 * buffer is full every new line evicts one at the top, and anchoring answers
 * by moving scrollTop up by the evicted line's height, a scroll nobody asked
 * for. In WebKit that adjustment's scroll event was what turned following off.
 * While reading back, anchoring is what holds the operator's line still as
 * lines are evicted above it.
 */
function useFollowNewest(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  hasLines: boolean,
  lines: TranscriptLineDTO[],
): (() => void) | undefined {
  const followingRef = useRef(true);
  /** scrollTop as of the last scroll event or pin, to tell an upward scroll. */
  const lastTopRef = useRef(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (enabled && el) pinOrRelease(el, followingRef, lastTopRef);
  }, [scrollRef, enabled, lines]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || !el) return;
    setFollowing(el, followingRef, followingRef.current);
    // Guarded: not every embedded or kiosk browser this app runs in has it, and
    // the follow on each new line does not depend on it.
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => pinOrRelease(el, followingRef, lastTopRef));
    ro?.observe(el);
    if (content) ro?.observe(content);
    return () => {
      el.style.overflowAnchor = "";
      ro?.disconnect();
    };
  }, [scrollRef, contentRef, enabled, hasLines]);

  if (!enabled) return undefined;
  return () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // Read here, not through atBottom(): fit-one-measurement.test.ts lists this hook
    // as one that observes a box and reads its content's size, and it sees only
    // a read written inside the hook.
    if (el.scrollHeight - top - el.clientHeight <= AT_BOTTOM_PX) setFollowing(el, followingRef, true);
    // Upward, and not by us: every pin records where it left scrollTop,
    // anchoring is off while following, and a browser's own clamp when content
    // shrinks lands at the bottom, above.
    else if (top < lastTopRef.current) setFollowing(el, followingRef, false);
    lastTopRef.current = top;
  };
}

/**
 * Bottom-anchored, multi-speaker transcript feed: newest line at the bottom,
 * older lines shifting up. Shared by the full-screen transcription view and the
 * compact "Transcription" layout object so they behave identically.
 */
export function TranscriptFeed({
  lines,
  maxLines,
  scrollable = false,
  showLabels,
  colorOverrides,
  followProdcom = false,
  textStyle,
  lineClassName,
  gapClassName = "gap-3",
  emptyText,
  className,
}: TranscriptFeedProps) {
  const visible = maxLines != null ? lines.slice(-maxLines) : lines;
  const labels = showLabels ?? visible.some((l) => l.channelName || l.channel);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasLines = !(visible.length === 0 && emptyText);
  const onScroll = useFollowNewest(scrollRef, contentRef, scrollable, hasLines, lines);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={scrollable ? textStyle : { ...textStyle, overflow: "clip" }}
      className={cn(
        "flex flex-col min-h-0",
        // A CLIPPED feed has to overflow off the TOP: the newest line is the one
        // being read, so it is the one that must survive. justify-end does that.
        // mt-auto alone cannot — see the note on the inner element.
        //
        // And it must not be a scroll container, which is why the inline style
        // above says `overflow: clip`. As `overflow: hidden` it is one, and Safari
        // scrolls it: WebKit makes the overflow above a justify-end box
        // reachable (a negative scrollTop), and on a console its scroll anchoring
        // then held the lines on screen still while new ones were appended below
        // them. The feed froze on old lines, cut off at the bottom, with the
        // newest ones out of sight, until a reload reset the offset. A clipped
        // box has no scroll offset, so nothing can move it.
        //
        // overflow-hidden stays as the class only as the fallback for an engine
        // without `overflow: clip`, which drops the inline value and keeps this.
        scrollable ? "overflow-y-auto" : "overflow-hidden justify-end",
        className,
      )}
    >
      {visible.length === 0 && emptyText ? (
        <div className="m-auto">
          <span className="text-title3 text-fg-faint">{emptyText}</span>
        </div>
      ) : (
        // SCROLLABLE only: `mt-auto` bottom-anchors the lines when they don't
        // fill the box, then collapses once they overflow so the viewer can
        // still scroll up to older lines — which justify-end would make
        // unreachable.
        //
        // That collapse is exactly why it is wrong for the clipped feed: with no
        // scrollbar to recover them, the overflowing lines spilled off the
        // BOTTOM and cut off the newest one mid-sentence.
        <div ref={contentRef} className={cn(scrollable && "mt-auto", "flex flex-col", gapClassName)}>
          {visible.map((l) => (
            <TranscriptLineRow
              key={l.id}
              line={l}
              labels={labels}
              colorOverrides={colorOverrides}
              followProdcom={followProdcom}
              lineClassName={lineClassName}
            />
          ))}
        </div>
      )}
    </div>
  );
}
