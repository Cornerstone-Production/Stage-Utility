import * as React from "react";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/cn";

// Hide the browser's native number spinner — we render our own themed steppers.
const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0";

export interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
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

  React.useEffect(() => {
    if (!editing) setText(String(Number.isFinite(value) ? value : 0));
  }, [value, editing]);

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
    setText(String(next));
  }

  return (
    <div
      className={cn(
        "inline-flex h-7 w-full items-stretch overflow-hidden rounded-md border border-gray-a6 bg-gray-a2",
        "transition-colors focus-within:border-blue-8 focus-within:ring-1 focus-within:ring-blue-8",
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
          } else {
            const clamped = clamp(Number.parseFloat(text));
            setText(String(clamped));
            if (clamped !== value) onChange(clamped);
          }
        }}
        onChange={(e) => commitText(e.target.value)}
        className={cn("min-w-0 flex-1 bg-transparent px-2.5 py-1 text-[13px] text-gray-12 tabular-nums outline-none", NO_SPINNER)}
      />
      {suffix && (
        <span className="pointer-events-none flex select-none items-center pr-1 text-caption2 text-gray-8">{suffix}</span>
      )}
      <div className="flex w-6 shrink-0 flex-col border-l border-gray-a6">
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Increase"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => bump(1)}
          className="flex flex-1 items-center justify-center text-gray-9 transition-colors hover:bg-gray-a4 hover:text-gray-12"
        >
          <ChevronUpIcon className="size-3" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Decrease"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => bump(-1)}
          className="flex flex-1 items-center justify-center border-t border-gray-a6 text-gray-9 transition-colors hover:bg-gray-a4 hover:text-gray-12"
        >
          <ChevronDownIcon className="size-3" />
        </button>
      </div>
    </div>
  );
}
