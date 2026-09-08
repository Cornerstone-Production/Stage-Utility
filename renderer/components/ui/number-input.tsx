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

/** How long a stepper must be held before it starts repeating. */
export const STEPPER_REPEAT_DELAY_MS = 400;
/** How often it repeats once it does. */
export const STEPPER_REPEAT_INTERVAL_MS = 80;

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

  // The RUNNING value for the press currently in progress, not the `value`
  // prop: a controlled component's prop only catches up once the parent has
  // re-rendered from `onChange`, and a repeat's own `setInterval` is a closure
  // taken once at press-start — reading `value` from it would ask the same
  // question every 80ms and get the same stale answer every time, so a held
  // stepper would fire once and then appear to do nothing. This ref is
  // reset to the prop at the START of every press (see `startRepeat`) so a
  // press always steps from wherever the field actually is, including a value
  // that changed out from under it between presses.
  const heldValue = React.useRef(value);

  function bumpOnce(dir: 1 | -1) {
    const base = Number.isFinite(heldValue.current) ? heldValue.current : 0;
    const next = clamp(Number((base + dir * step).toFixed(6)));
    heldValue.current = next;
    onChange(next);
    onCommit?.(next);
    setText(String(next));
  }

  // Press-and-hold repeat: one step on pointerdown, then — if still held after
  // STEPPER_REPEAT_DELAY_MS — one step every STEPPER_REPEAT_INTERVAL_MS until
  // release. The SAME path for a mouse and a finger: a mouse held on the
  // stepper repeats too, which is what a native OS spinner does and what a
  // coarse pointer needs since there is no keyboard repeat to fall back on.
  const repeat = React.useRef<{ delay: ReturnType<typeof setTimeout> | null; interval: ReturnType<typeof setInterval> | null }>({
    delay: null,
    interval: null,
  });

  function stopRepeat() {
    if (repeat.current.delay != null) clearTimeout(repeat.current.delay);
    if (repeat.current.interval != null) clearInterval(repeat.current.interval);
    repeat.current.delay = null;
    repeat.current.interval = null;
  }

  function startRepeat(dir: 1 | -1) {
    heldValue.current = value;
    bumpOnce(dir);
    repeat.current.delay = setTimeout(() => {
      repeat.current.interval = setInterval(() => bumpOnce(dir), STEPPER_REPEAT_INTERVAL_MS);
    }, STEPPER_REPEAT_DELAY_MS);
  }

  // A press abandoned by unmount (the setting it steps disappears mid-hold —
  // a service ends, a panel closes) must not go on calling a now-stale
  // `onChange` into the void.
  React.useEffect(() => stopRepeat, []);

  return (
    <div
      className={cn(
        // No `overflow-hidden` here — the steppers' `touch-target-y` pseudo (see
        // styles.css) has to reach past this row's own top/bottom edge to hit
        // 44px tall under a coarse pointer, and a clipping ancestor would cut
        // it off before it got there. `-y`, not the plain `touch-target`: the
        // two steppers sit flush against each other with no gap, so a pseudo
        // that also grew sideways would reach past their shared border into
        // the neighbouring stepper's own territory — a tap meant for Decrease
        // landing on Increase instead. The rounded pill look survives anyway:
        // the border below draws the shape regardless of overflow, and the one
        // child that could have shown a square corner outside it — the
        // Increase button, which sits at the row's own top-right/bottom-right
        // — carries its own `rounded-r-md` to match.
        "inline-flex h-7 w-full items-stretch rounded-md border border-line bg-field",
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
          onPointerDown={(e) => {
            // Only the primary button/finger steps the value — a right-click
            // used to step it too, WHILE the browser's own context menu opened
            // on top, so "5" silently became "6" under a menu the operator
            // never asked to change anything through.
            if (e.button !== 0 || !e.isPrimary || disabled) return;
            startRepeat(-1);
          }}
          onPointerUp={stopRepeat}
          onPointerCancel={stopRepeat}
          onPointerLeave={stopRepeat}
          className="touch-target-y flex w-6 items-center justify-center text-fg-subtle transition-colors hover:bg-fill-hover hover:text-fg active:text-accent disabled:opacity-50"
        >
          <MinusIcon className="size-3.5" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Increase"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary || disabled) return;
            startRepeat(1);
          }}
          onPointerUp={stopRepeat}
          onPointerCancel={stopRepeat}
          onPointerLeave={stopRepeat}
          // `rounded-r-md` — see the wrapper's own comment on why it lost
          // `overflow-hidden`: this button now owns the row's top-right and
          // bottom-right corners for real, rather than being clipped into
          // shape by an ancestor.
          className="touch-target-y flex w-6 items-center justify-center rounded-r-md border-l border-line text-fg-subtle transition-colors hover:bg-fill-hover hover:text-fg active:text-accent disabled:opacity-50"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
