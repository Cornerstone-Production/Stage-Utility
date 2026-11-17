// Small parts the Theme photos panel and the Manage themes view share: a photo
// in a circle, a numeral, a status chip, a pair of photos with an arrow.

import { AlertCircleIcon, ChevronRightIcon, ImageIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../../lib/cn";

/** A numeral, in Plex Mono. */
export function Num({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
}

/** The same `/photos` route every slot draws a Planning Center photo through. */
export const planningCenterPhoto = (url: string) => `/photos?u=${encodeURIComponent(url)}&s=136`;

/** A photo in a circle. A photo that will not load falls back to the empty circle
 *  rather than the browser's broken-image glyph. */
export function Avatar({ src, label }: { src: string | null; label: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <Placeholder tone="none" label={`${label}, no photo`} />;
  return <img src={src} alt={label} loading="lazy" onError={() => setFailed(src)} className="size-[68px] flex-none rounded-full bg-fill object-cover" />;
}

/** What stands where a photo is not: nothing yet, being made, or failed. */
export function Placeholder({ tone, label }: { tone: "none" | "making" | "failed"; label: string }) {
  if (tone === "making") {
    return <span role="img" aria-label={label} data-photo-making className="su-photo-shimmer size-[68px] flex-none rounded-full bg-fill" />;
  }
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "grid size-[68px] flex-none place-items-center rounded-full border border-dashed border-line-strong",
        tone === "failed" ? "text-danger-11" : "text-fg-subtle",
      )}
    >
      {tone === "failed" ? <AlertCircleIcon className="size-4" aria-hidden /> : <ImageIcon className="size-4" aria-hidden />}
    </span>
  );
}

function Captioned({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <span className="flex flex-col items-center gap-[3px]">
      {children}
      <span className="text-[10px] uppercase tracking-[0.06em] text-fg-subtle">{caption}</span>
    </span>
  );
}

/** Original, an arrow, and what it became. `original` undefined leaves the original out (a card that cannot know it). */
export function PhotoPair({ original, edited, editedCaption = "Edited" }: { original?: ReactNode; edited: ReactNode; editedCaption?: string }) {
  return (
    <div className="mt-2.5 flex items-center justify-center gap-2">
      {original !== undefined && (
        <>
          <Captioned caption="Original">{original}</Captioned>
          <ChevronRightIcon className="size-3 text-fg-subtle" aria-hidden />
        </>
      )}
      <Captioned caption={editedCaption}>{edited}</Captioned>
    </div>
  );
}

export type ChipTone = "plain" | "ready" | "ok" | "bad" | "warn";
const CHIP: Record<ChipTone, string> = {
  plain: "bg-fill text-fg-muted",
  ready: "bg-accent-soft text-accent-soft-fg",
  ok: "bg-ok-9/15 text-ok-11",
  bad: "bg-danger-9/12 text-danger-11",
  warn: "bg-warn-9/15 text-warn-11",
};

export function Chip({ tone = "plain", icon, children, ...rest }: { tone?: ChipTone; icon?: ReactNode; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <span {...rest} className={cn("inline-flex items-center gap-[5px] self-start rounded-full py-px pl-1.5 pr-2 text-[11.5px] font-medium leading-[17px]", CHIP[tone])}>
      {icon}
      {children}
    </span>
  );
}

/** The theme a photo belongs to, as a small tag. */
export function ThemeTag({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <span title="Theme" className="inline-flex max-w-full items-center gap-1 self-start overflow-hidden text-ellipsis whitespace-nowrap rounded border border-line-strong py-0 pl-[5px] pr-[7px] text-[10.5px] leading-4 text-fg-muted">
      {icon}
      {children}
    </span>
  );
}

/** A confirm, inline in the card or panel it is about. Never a window. */
export function InlineBox({ label, children, danger }: { label: string; children: ReactNode; danger?: boolean }) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-col gap-1.5 rounded-lg bg-fill p-2 text-caption1", danger && "ring-1 ring-danger-9/30")}>
      {children}
    </div>
  );
}
