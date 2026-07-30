import { useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/cn";

/**
 * A lightweight disclosure: a chevron + label header that toggles a collapsible
 * region. Standardizes the manual chevron pattern used across the app (slot
 * "Options", integration cards, caption colors). The toggle lives on the
 * label button only, so interactive controls passed via `right` (e.g. an enable
 * switch) don't collapse the section.
 */
export function Collapsible({
  label,
  summary,
  afterLabel,
  defaultOpen = false,
  right,
  children,
  className,
  headerClassName,
}: {
  /** Header text/content next to the chevron. */
  label: ReactNode;
  /** Muted hint shown after the label only while collapsed (e.g. "mic · IEM"). */
  summary?: ReactNode;
  /** Non-toggling content placed right after the label (e.g. an info "i"). Kept
   *  outside the toggle button so it can be its own interactive element. */
  afterLabel?: ReactNode;
  defaultOpen?: boolean;
  /** Non-toggling trailing header content (e.g. a status badge + enable switch). */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("flex flex-col", className)}>
      <div className={cn("flex items-center gap-2", headerClassName)}>
        {/* The label group owns all the leftover width and is the only thing that
            shrinks; `right` never does. A long label therefore has to clip inside
            here instead of overflowing and painting over the status/toggle.
            Previously the button hugged its content whenever an afterLabel was
            present, and a phantom flex-1 spacer pushed the trailing content — so
            an over-wide label had nothing bounding it. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* The button is NOT the flex container. Safari wraps the contents of a
              <button> in an anonymous box, so flex children inside one frequently
              refuse to shrink — the label then keeps its full width, overflows,
              and paints over the status and toggle. Chromium and headless WebKit
              do not reproduce it; iOS Safari does. Putting an ordinary <span>
              inside the button and making THAT the flex container is the standard
              workaround. */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={cn(
              "block min-w-0 py-1 text-caption1 font-medium text-fg-subtle hover:text-fg transition-colors text-left",
              // Fill the group so the whole row toggles — unless an afterLabel has
              // to sit immediately after the text.
              !afterLabel && "flex-1",
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
              {/* Label and summary align on their BASELINES, not their boxes. They are
                  usually different sizes (a 16px title beside 11px summary text), and
                  centring two boxes of different heights leaves the baselines apart —
                  which reads as the smaller text sitting low. The chevron stays centerd,
                  which is why this is its own group rather than the row itself. */}
              <span className="flex min-w-0 items-baseline gap-1.5">
                {/* overflow-hidden here as well as on whatever `label` is: min-w-0
                    only permits shrinking, it does not clip. */}
                <span className="min-w-0 truncate">{label}</span>
                {!open && summary != null && (
                  <span className="shrink-0 truncate text-caption2 font-normal text-gray-8">{summary}</span>
                )}
              </span>
            </span>
          </button>
          {afterLabel}
        </div>
        {right != null && <div className="shrink-0">{right}</div>}
      </div>
      {open && <div className="mt-1.5 flex flex-col gap-1.5">{children}</div>}
    </div>
  );
}
