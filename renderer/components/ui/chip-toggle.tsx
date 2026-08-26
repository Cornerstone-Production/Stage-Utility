// A pill you turn on and off — the control for "which of these do I want shown".
//
// There were four of these: two in the layout inspector (SPL channels, caption
// channels) and two in the history sections. All four were the same button with
// the same rounded-full pill geometry and the same accent-tinted on-state, and
// they had drifted into TWO DIALECTS for the off-state — the inspector pair used
// the semantic tokens (`bg-fill`, `text-fg-muted`, `border-line-strong`) and the
// history pair used the raw gray scale (`bg-gray-2`, `text-gray-10`,
// `border-gray-5`). Near-identical on screen, different in the file, and nothing
// to say which was right.
//
// The semantic tokens win: they are what the rest of the app is built on, and
// they follow the theme through one indirection instead of naming a step on a
// scale.

import { cn } from "../../lib/cn";

export interface ChipToggleProps {
  /** What the pill says. */
  label: string;
  /** On = included/shown. The accent tint is the on-state. */
  on: boolean;
  onToggle: () => void;
  className?: string;
}

export function ChipToggle({ label, on, onToggle, className }: ChipToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      // aria-pressed, not just colour: a toggle that only says what it is by
      // being tinted says nothing to a screen reader.
      aria-pressed={on}
      className={cn(
        "rounded-full border px-2.5 py-1 text-caption2 transition-colors",
        on
          ? "border-accent/50 bg-accent/12 text-accent"
          : "border-line-strong bg-fill text-fg-muted hover:bg-fill-hover",
        className,
      )}
    >
      {label}
    </button>
  );
}

/** The row these sit in. Every caller wrapped them in exactly this. */
export function ChipToggleRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}
