import * as React from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { MinusIcon, PlusIcon } from "lucide-react";
import { cn } from "../../lib/cn";

// Hide the browser's native number spinner — we render our own themed steppers.
const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0";

export interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  /** Fired on a "settled" value — blur or a stepper click — for commit-on-blur
   *  callers (onChange still fires live for dirty-tracking). */
  onCommit?: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Short unit shown inside the field (e.g. "in", "px"). */
  suffix?: string;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}

/**
 * Themed number field used across settings. Commits live on every change and on
 * each stepper click (so dirty-tracking fires), selects-all on focus, can be
 * cleared while typing, and replaces the browser's native up/down spinners with
 * styled chevron steppers that match the app.
 */
export function NumberInput({
  value,
  onChange,
  onCommit,
  step = 1,
  min,
  max,
  suffix,
  className,
  disabled,
  ...rest
}: NumberInputProps) {
  const [text, setText] = React.useState(() => String(value));
  const [editing, setEditing] = React.useState(false);

  useResyncOn([value, editing], () => {
    if (!editing) setText(String(Number.isFinite(value) ? value : 0));
  });

  const clamp = (n: number) => {
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
  };

  function commitText(raw: string) {
    setText(raw);
    if (raw.trim() === "") return; // allow an empty field mid-edit; don't commit
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return;
    onChange(clamp(n));
  }

  function bump(dir: 1 | -1) {
    const base = Number.isFinite(value) ? value : 0;
    const next = clamp(Number((base + dir * step).toFixed(6)));
    onChange(next);
    onCommit?.(next);
    setText(String(next));
  }

  return (
    <div
      className={cn(
        "inline-flex h-7 w-full items-stretch overflow-hidden rounded-md border border-line bg-field",
        "transition-colors focus-within:border-focus focus-within:ring-1 focus-within:ring-focus",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <input
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-label={rest["aria-label"]}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setEditing(false);
          if (text.trim() === "" || !Number.isFinite(Number.parseFloat(text))) {
            setText(String(Number.isFinite(value) ? value : 0));
            onCommit?.(Number.isFinite(value) ? value : 0);
          } else {
            const clamped = clamp(Number.parseFloat(text));
            setText(String(clamped));
            if (clamped !== value) onChange(clamped);
            onCommit?.(clamped);
          }
        }}
        onChange={(e) => commitText(e.target.value)}
        className={cn("min-w-0 flex-1 bg-transparent px-2.5 py-1 text-footnote text-fg tabular-nums outline-none", NO_SPINNER)}
      />
      {suffix && (
        <span className="pointer-events-none flex select-none items-center pr-1 text-caption2 text-gray-8">{suffix}</span>
      )}
      {/* Horizontal −/+ steppers grouped on the right. Bigger, calmer targets
          than a stacked chevron column, and touch-friendly on kiosk panels. */}
      <div className="flex shrink-0 border-l border-line">
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Decrease"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => bump(-1)}
          className="flex w-6 items-center justify-center text-fg-subtle transition-colors hover:bg-fill-hover hover:text-fg active:text-accent disabled:opacity-50"
        >
          <MinusIcon className="size-3.5" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Increase"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => bump(1)}
          className="flex w-6 items-center justify-center border-l border-line text-fg-subtle transition-colors hover:bg-fill-hover hover:text-fg active:text-accent disabled:opacity-50"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
