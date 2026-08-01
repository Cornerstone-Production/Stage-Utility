import { useEffect, useRef, type CSSProperties } from "react";
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
    if (scrollable && atBottomRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [lines, scrollable]);

  return (
    <div
      ref={scrollRef}
      onScroll={scrollable ? onScroll : undefined}
      style={textStyle}
      className={cn(
        "flex flex-col min-h-0",
        scrollable ? "overflow-y-auto" : "overflow-hidden",
        className,
      )}
    >
      {visible.length === 0 && emptyText ? (
        <div className="m-auto">
          <span className="text-title3 text-fg-faint">{emptyText}</span>
        </div>
      ) : (
        // `mt-auto` bottom-anchors the lines when they don't fill the box, but
        // (unlike justify-end on a scroll container) collapses once they
        // overflow so the viewer can still scroll up to older lines.
        <div className={cn("mt-auto flex flex-col", gapClassName)}>
          {visible.map((l) => (
            <p
              key={l.id}
              className={cn("leading-snug", lineClassName)}
              style={{ color: lineColor(l, colorOverrides), opacity: l.isFinal ? 1 : 0.55 }}
            >
              {labels && (l.channelName || l.channel) && (
                <span className="text-[0.5em] font-medium uppercase tracking-wider text-fg-subtle mr-[0.6em] align-middle">
                  {l.channelName ?? l.channel}
                </span>
              )}
              {l.text}
            </p>
          ))}
          {scrollable && <div ref={endRef} />}
        </div>
      )}
    </div>
  );
}
