import { Fragment } from "react";

import type { ChainNode } from "../lib/patch-view-model";
import { cn } from "../lib/cn";

// The stacked layout wraps; the table keeps a path on one line and draws it the
// way the mockup does: monospace, a hairline box, the console end dashed.
const PILL: Record<ChainNode["kind"], string> = {
  source: "border-line-strong bg-fill-active text-fg font-medium",
  hop: "border-line bg-surface text-fg-muted font-mono",
  rack: "border-line-strong bg-surface text-fg font-mono",
  console: "border-line bg-transparent text-fg-subtle font-mono",
};
const COMPACT_PILL: Record<ChainNode["kind"], string> = {
  source: "border-line-strong text-fg-muted",
  hop: "border-line-strong text-fg-muted",
  rack: "border-fg/35 text-fg",
  console: "border-dashed border-line-strong text-fg-muted",
};

/** SVG chevron connector between diagram nodes. */
function Arrow({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className={cn("shrink-0 text-fg-faint", className)} aria-hidden="true">
      <path d="M4 2.5 L7.5 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A signal path drawn as connected nodes: source → hops → rack → console. */
export function PatchChain({
  nodes,
  compact = false,
  dropConsoleInNarrowCard = false,
}: {
  nodes: ChainNode[];
  compact?: boolean;
  /** For a chain inside an `@container`: below ~62rem of card width the console
   *  node is not drawn. The table has the console channel in a column of its own,
   *  and the whole path is about 985px, so on a laptop with the sidebar open the
   *  alternative is the note column scrolled out of sight. */
  dropConsoleInNarrowCard?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-1", compact ? "w-max flex-nowrap" : "flex-wrap")}>
      {nodes.map((n, i) => {
        const droppable = dropConsoleInNarrowCard && n.kind === "console";
        return (
          <Fragment key={i}>
            {i > 0 && <Arrow className={droppable ? "hidden @min-[62rem]:block" : undefined} />}
            <span
              className={cn(
                "border whitespace-nowrap",
                compact ? `rounded-[5px] px-1.5 py-px font-mono text-caption1 ${COMPACT_PILL[n.kind]}` : `rounded-md px-2 py-0.5 text-caption2 ${PILL[n.kind]}`,
                droppable && "hidden @min-[62rem]:inline",
              )}
            >
              {n.text}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
