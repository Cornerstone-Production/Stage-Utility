import * as React from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { MinusIcon, PlusIcon } from "lucide-react";
import { cn } from "../../lib/cn";

// Hide the browser's native number spinner — we render our own themed steppers.
const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0";

export interface NumberInputProps {
  /** `null` is "no value". It renders as an empty box only for a caller that
   *  passed {@link NumberInputProps.onUnset}; without one it renders 0, which is
   *  what every caller passing a plain number has always seen. */
  value: number | null;
  onChange: (value: number) => void;
  /** Fired on a "settled" value — blur or a stepper click — for commit-on-blur
   *  callers (onChange still fires live for dirty-tracking). */
  onCommit?: (value: number) => void;
  /**
   * Let this field be EMPTY, and hear about it when it is.
   *
   * THE CALLBACK IS THE OPT-IN, deliberately: without it the component has no
   * way to tell a caller "there is no value now", so it must not be able to
   * reach that state — and every one of the twenty-odd existing call sites,
   * none of which passes one, keeps today's behaviour unchanged down to the
   * blur path. A boolean flag beside the callback could be set without it, and
   * a field that silently went blank while its owner still held the old number
   * is a worse bug than the one this prop fixes.
   *
   * For a field where blank is a real answer rather than a missing one: a poll
   * interval that falls back to the service's own, a port that simply is not
   * configured yet. Those fields used to render `0`, and a focus-and-blur on
   * that 0 committed it through the clamp below as a number the operator never
   * chose.
   *
   * Fires wherever `onChange` would fire for a number (on the keystroke that
   * empties the box) and again wherever `onCommit` would (on blur), so both a
   * dirty-tracking caller and a commit-on-blur caller hear it. It therefore
   * fires more than once for a single clearing and must be idempotent —
   * "set this to nothing" always is.
   */
  onUnset?: () => void;
  /** Shown in the box while it is empty. Only ever visible with `onUnset`,
   *  since nothing else can leave the box empty once focus has left it. */
  placeholder?: string;
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
 *
 * Pass {@link NumberInputProps.onUnset} for a field where BLANK is a real
 * setting rather than a missing one; without it the field behaves exactly as it
 * always has, 0 included.
 */
export function NumberInput({
  value,
  onChange,
  onCommit,
  onUnset,
  placeholder,
  step = 1,
  min,
  max,
  suffix,
  className,
  disabled,
  ...rest
}: NumberInputProps) {
  /** What the box shows for a value nobody is currently typing into.
   *
   *  Without `onUnset` this is the old `String(Number.isFinite(v) ? v : 0)` to
   *  the character. With one, anything that is not a real number — `null`, and
   *  NaN, which is how the absent value used to arrive here — shows as empty
   *  rather than as a 0 the operator would read as a setting. */
  const display = (v: number | null): string =>
    Number.isFinite(v) ? String(v) : onUnset ? "" : "0";

  /** The value as a number, for the callbacks that are typed to take one. */
  const asNumber = (v: number | null): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const [text, setText] = React.useState(() => display(value));
  const [editing, setEditing] = React.useState(false);

  /** Did the operator CHANGE this box during the visit that is ending?
   *
   *  A blur used to clamp and commit whatever the box held, whether or not
   *  anything had been typed into it — so a stored value outside the field's
   *  bounds was silently rewritten by a click in and a click out. An operator
   *  running `pollMs: 100` from before the field declared `min: 200` opened the
   *  ProPresenter card, looked at the interval, closed it, and the next save
   *  made for any other reason stored 200: a five-fold request-rate increase
   *  nobody chose, from a gesture that changed nothing. `ross-tsl.port` did the
   *  same with 70000 -> 65535.
   *
   *  A ref, not state: nothing renders differently because of it, and it has to
   *  be readable by the blur handler in the same tick the last keystroke set it.
   *
   *  Set by `commitText`, the only path a keystroke takes, and cleared at BOTH
   *  ends of a visit — on focus, and again on the way out of blur. Either alone
   *  would do in a browser, where a blur always follows a focus; clearing on the
   *  way out as well means two blurs in a row cannot commit the same edit twice,
   *  without the handler having to assume anything about the order it is called
   *  in.
   *
   *  A stepper press deliberately does NOT set it: `bumpOnce` has already called
   *  `onChange` and `onCommit` with the stepped value, and a blur that committed
   *  it again would be writing the same number twice. */
  const edited = React.useRef(false);

  useResyncOn([value, editing], () => {
    if (!editing) setText(display(value));
  });

  const clamp = (n: number) => {
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
  };

  function commitText(raw: string) {
    edited.current = true;
    setText(raw);
    if (raw.trim() === "") {
      // An empty box is a REAL answer where the caller can take one, and it is
      // reported on the keystroke rather than saved up for blur. A form's Save
      // button is disabled until something reports a change, and a disabled
      // button does not take the mousedown that would have blurred this field —
      // so deferring meant clearing a field, reaching for Save, and finding it
      // still greyed out with no way to commit the clearing at all.
      //
      // Everywhere else this stays what it was: an empty field mid-edit commits
      // NOTHING, because for a field that must hold a number, momentarily
      // persisting 0 is a busy loop or an unbindable port written to disk.
      onUnset?.();
      return;
    }
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
  const heldValue = React.useRef<number | null>(value);

  function bumpOnce(dir: 1 | -1) {
    const base = heldValue.current;
    // From an EMPTY box there is no number to step FROM, so the first press in
    // either direction lands on `clamp(0)` — zero, pulled up to whatever floor
    // the field declares — and the press after that steps from there.
    //
    // For the three fields that ship this today that is INDISTINGUISHABLE from
    // the `0 ± step` below, and an earlier comment here claimed otherwise: it
    // said `0 + step` "read as 11" on a field with a floor of 10, which it never
    // did. All three declare a `min` larger than their step (200 / 1 / 10), so
    // `clamp(0 ± step)` lands on that same floor in both directions. Two
    // properties make this the right spelling anyway, and number-input.test.tsx
    // pins both with cases that really do tell the two apart:
    //
    //   - `+` cannot OVERSHOOT the floor. `min: 10, step: 100` gives 100 for
    //     `0 + step`, for a press that was asking for the smallest value the
    //     field permits.
    //   - `-` cannot go NEGATIVE where no floor is declared. `0 - step` is -1,
    //     and that is the hole ross-tsl.port needed a `min: 1` to close:
    //     getRossTslConfig discards anything not > 0 in silence while
    //     configuredFor() still reads the card as set up.
    //
    // `clamp(0)`, not `clamp(min ?? 0)`: `clamp` already raises 0 to `min`, and
    // the two differ only for a NEGATIVE floor — where landing on 0 is the
    // better answer anyway. The app has one such field today (the automation
    // `offsetMinutes` param, min -720, reached through rule-editor-dialog), and
    // it does not opt in.
    //
    // Only for a caller that opted in. Everyone else keeps `0 ± step` exactly,
    // because "not a number" is reachable for them too, if barely: one call site
    // spells its value `Number(value ?? spec.min ?? 0)`, which is NaN for a
    // param holding a non-numeric string. That is recovery from a value that was
    // never valid either way, and this is not the change to alter it in.
    //
    // `typeof base === "number"` is not redundant beside `Number.isFinite`: the
    // latter takes `unknown` and is not a type predicate, so it is the `typeof`
    // that narrows `number | null` for the arithmetic below.
    const next =
      typeof base === "number" && Number.isFinite(base)
        ? clamp(Number((base + dir * step).toFixed(6)))
        : clamp(onUnset ? 0 : Number((dir * step).toFixed(6)));
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
        // `min-w-0 flex-1` beside `w-full`: in a flex row (an inspector Row with a
        // swatch before the number, the Canvas popover's width x height) a plain
        // w-full child cannot shrink below 100% of the row, so the second field
        // ran 36px past the inspector's edge and the panel scrolled sideways.
        // In a grid cell or a label the two are inert and w-full still applies.
        "inline-flex h-7 w-full min-w-0 flex-1 items-stretch rounded-md border border-line bg-field",
        "transition-colors focus-within:border-focus focus-within:ring-1 focus-within:ring-focus",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={rest["aria-label"]}
        onFocus={(e) => {
          setEditing(true);
          edited.current = false;
          e.currentTarget.select();
        }}
        onBlur={() => {
          setEditing(false);
          // The visit is over whichever branch below runs.
          const wasEdited = edited.current;
          edited.current = false;
          // NOTHING WAS TYPED, so there is nothing to commit and nothing to
          // clamp. Only a value the operator entered IN THIS EDIT gets pulled
          // inside the field's bounds; a value that was already stored is left
          // exactly as it is, out of bounds or not, for the same reason the
          // blank-field path below exists — a click in and a click out is not
          // an edit, and it must not change what is on disk. The operator can
          // still fix it by typing, and a field they never touch stays theirs.
          //
          // `setText` rather than a bare return: a blur can arrive without a
          // preceding focus (React's own `fireEvent.blur`, and a programmatic
          // one), and then `setEditing(false)` changes nothing, so the resync
          // above does not run and the box would keep a stepper's text.
          if (!wasEdited) {
            setText(display(value));
            return;
          }
          const typed = text.trim();
          const n = Number.parseFloat(typed);
          if (typed !== "" && Number.isFinite(n)) {
            const clamped = clamp(n);
            setText(String(clamped));
            if (clamped !== value) onChange(clamped);
            onCommit?.(clamped);
            return;
          }
          // Nothing usable in the box. EMPTY is an answer where the caller can
          // take one, so it settles as empty rather than springing back to a
          // number — that spring-back is the whole bug: a field showing a 0 it
          // was never set to committed that 0, clamped up to `min`, for nothing
          // more than a click in and a click out.
          //
          // JUNK ("abc") is not an answer, so it reverts to whatever the value
          // is — and where that value is itself absent, reverting IS going back
          // to empty. Only the second clause makes that true; without it a typo
          // on a blank field would have committed 0 by the branch below.
          if (onUnset && (typed === "" || value == null)) {
            onUnset();
            setText("");
            return;
          }
          setText(display(value));
          onCommit?.(asNumber(value));
        }}
        onChange={(e) => commitText(e.target.value)}
        // `placeholder:text-gray-a8` is the themed Input's own placeholder
        // token. Without it the hint renders in the browser's default — 50% of
        // the text colour — which is close enough to read as a real value at a
        // glance on a dark surface, and only a browser shows the difference.
        className={cn(
          "min-w-0 flex-1 bg-transparent px-2.5 py-1 text-footnote text-fg tabular-nums outline-none",
          "placeholder:text-gray-a8",
          NO_SPINNER,
        )}
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
