// One of a few, chosen on a tinted track: the Customize tray's Sidebar and
// Context bar tabs, and which bar (desktop or phone) is being edited.
//
// The active segment is RAISED, not merely tinted. Which thing you are editing
// is the one fact in an editor you cannot afford to be unsure about (a save goes
// somewhere either way), so it is carried by fill and elevation rather than by a
// colour a glance can miss.

import type { ComponentType } from "react";

import { cn } from "../../lib/cn";

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

export function SegmentedSwitch<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** What is being chosen, for a screen reader. */
  label: string;
}) {
  return (
    // INLINE-flex, so the tinted track is the width of its chips. A block `flex`
    // fills its line, and the tint then ran the width of the panel for a few
    // buttons, reading as a filled row rather than a segmented control.
    <div role="group" aria-label={label} className="inline-flex items-center gap-px rounded-lg bg-accent-soft p-0.5">
      {options.map(({ id, label: text, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => value !== id && onChange(id)}
          aria-pressed={value === id}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-focus",
            value === id ? "bg-surface font-semibold text-fg shadow-(--su-shadow-1)" : "font-medium text-fg-muted hover:text-fg",
          )}
        >
          {/* THE ICON CARRIES THE STATE, not the fill alone. Focus draws a ring
              the same shape and size as the raised chip, so a focused inactive
              segment read as the selected one. A colour the ring does not use
              settles it. */}
          <Icon className={cn("size-[13px]", value === id && "text-accent")} />
          {text}
        </button>
      ))}
    </div>
  );
}
