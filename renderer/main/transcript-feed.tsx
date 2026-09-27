import { memo, useEffect, useRef, type CSSProperties } from "react";
import { cn } from "../lib/cn";
import { lineColor } from "./channel-color";

interface TranscriptFeedProps {
  lines: TranscriptLineDTO[];
  /** Cap to the last N lines (compact layout object). Omit to show all (full view). */
  maxLines?: number;
  /** Allow the viewer to scroll history; auto-follows newest only when at bottom
   *  (full transcription view). Default false (compact object — no scrollbar). */
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

  // Follow the newest line only while already at the bottom; if the viewer
  // scrolls up to read history, leave them there until they return.
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }
  useEffect(() => {
    // Guarded the way service-history-section.tsx is: jsdom has no
    // scrollIntoView at all, and neither does every embedded/kiosk browser this
    // codebase already treats specially (see docs/integrations/ultritouch.md) —
    // unguarded, every live caption push would throw inside this effect there.
    if (scrollable && atBottomRef.current) endRef.current?.scrollIntoView?.({ block: "end" });
  }, [lines, scrollable]);

  return (
    <div
      ref={scrollRef}
      onScroll={scrollable ? onScroll : undefined}
      style={textStyle}
      className={cn(
        "flex flex-col min-h-0",
        // A CLIPPED feed has to overflow off the TOP: the newest line is the one
        // being read, so it is the one that must survive. justify-end does that.
        // mt-auto alone cannot — see the note on the inner element.
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
        <div className={cn(scrollable && "mt-auto", "flex flex-col", gapClassName)}>
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
          {scrollable && <div ref={endRef} />}
        </div>
      )}
    </div>
  );
}
