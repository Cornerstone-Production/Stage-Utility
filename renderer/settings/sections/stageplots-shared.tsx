// stageplots-shared.tsx — the small pieces the stage plots editor's cards share.

import { useState, type KeyboardEvent, type ReactNode } from "react";

import { Input } from "../../components/ui/input";
import { cn } from "../../lib/cn";
import { useResyncOn } from "../../lib/use-resync-on";

/** What a save answered: its value, or the sentence to show beside the control. */
export type Saved<T> = { ok: true; value: T } | { ok: false; error: string };

/** Run one save. Every structural change saves at once; this is how a card
 *  learns whether it landed, and what to say when it did not. */
export type Save = <T>(run: () => Promise<T>) => Promise<Saved<T>>;

/** A numeral, in Plex Mono. */
export function Num({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
}

export { eyebrow } from "../../main/stageplots/doc-helpers";

export const iconButton =
  "inline-grid shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";

export function CardHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[26px] items-center gap-2">
      <h3 className="min-w-0 flex-1 text-footnote font-semibold text-fg">{title}</h3>
      {children}
    </div>
  );
}

/** A failed save, beside the control that made it. Never reads as saved. */
export function SaveError({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn("text-caption1 text-danger-11", className)}>
      {message}
    </p>
  );
}

/** Two or more buttons, one pressed. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <span role="group" aria-label={label} className="flex flex-wrap items-center gap-1 self-start rounded-lg border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => o.value !== value && onChange(o.value)}
          className="rounded-md px-2.5 py-[3px] text-caption1 text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-fill aria-pressed:text-fg"
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

export const textareaClass =
  "w-full min-w-0 resize-y rounded-md border border-line-strong bg-field px-2.5 py-1.5 text-footnote leading-[17px] text-fg placeholder:text-gray-a8 transition-colors focus:border-focus focus:ring-1 focus:ring-focus focus:outline-none";

/**
 * A text field saved when it loses focus or Enter is pressed, and put back to
 * what the server holds when the save fails or Escape is pressed. A change
 * from elsewhere replaces it while it is not being edited.
 */
export function CommitText({
  value,
  onCommit,
  multiline,
  className,
  maxLength,
  ...aria
}: {
  value: string;
  onCommit: (next: string) => Promise<boolean>;
  multiline?: boolean;
  className?: string;
  maxLength?: number;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState(value);
  useResyncOn([value], () => setDraft(value));
  const commit = async () => {
    if (draft === value) return;
    if (!(await onCommit(draft))) setDraft(value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") setDraft(value);
    if (e.key === "Enter" && !multiline) e.currentTarget.blur();
  };
  return multiline ? (
    <textarea
      rows={2}
      value={draft}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={onKeyDown}
      className={cn(textareaClass, className)}
      {...aria}
    />
  ) : (
    <Input
      value={draft}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={onKeyDown}
      className={className}
      {...aria}
    />
  );
}
