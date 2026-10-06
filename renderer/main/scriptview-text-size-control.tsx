import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { MAX_TEXT_SIZE, MIN_TEXT_SIZE, parseTextSize, stepTextSize } from "./scriptview-text-size";

// A-  [ 100% ]  A+ in the ScriptView page's header.
//
// The steps and the typed-value rules are scriptview-text-size.ts; this is the
// control around them. Clicking the percentage turns it into a field holding the
// bare number. Enter or leaving the field commits it, Escape puts the old size
// back, and anything that is not a number does the same, so a typo never changes
// the size.

const STEP_BUTTON = "text-fg-muted hover:bg-white/10 hover:text-fg active:bg-white/15 rounded-none font-semibold";

export function TextSizeControl({ size, onChange }: { size: number; onChange: (size: number) => void }) {
  // The text being typed, or null when the field is showing the size itself.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set by Escape so the blur it causes does not commit what was typed.
  const reverting = useRef(false);

  // Select the number as the field turns editable, after the value it holds has
  // changed from "100%" to "100"; selecting in the focus handler would select the
  // old text.
  const editing = draft !== null;
  useLayoutEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit(): void {
    const typed = parseTextSize(draft);
    if (!reverting.current && typed !== null) onChange(typed);
    reverting.current = false;
    setDraft(null);
  }

  return (
    <div
      role="group"
      aria-label="Text size"
      className="flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-line bg-white/[0.06]"
    >
      <Button
        variant="transparent"
        iconOnly
        touchTargetY
        className={STEP_BUTTON}
        aria-label="Smaller text"
        disabled={size <= MIN_TEXT_SIZE}
        onClick={() => onChange(stepTextSize(size, -1))}
      >
        A−
      </Button>
      <input
        ref={inputRef}
        value={draft ?? `${size}%`}
        inputMode="decimal"
        aria-label="Text size, percent"
        onFocus={() => setDraft(String(size))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            reverting.current = true;
            e.currentTarget.blur();
          }
        }}
        className="h-full w-[3.25rem] cursor-text border-x border-line bg-transparent text-center font-mono text-caption1 text-fg tabular-nums outline-none hover:bg-white/10 focus:bg-white/[0.12]"
      />
      <Button
        variant="transparent"
        iconOnly
        touchTargetY
        className={STEP_BUTTON}
        aria-label="Larger text"
        disabled={size >= MAX_TEXT_SIZE}
        onClick={() => onChange(stepTextSize(size, 1))}
      >
        A+
      </Button>
    </div>
  );
}
