import { TriangleAlertIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/cn";

/**
 * A prominent, sticky "unsaved changes" bar shown at the top of an editor when it
 * has draft edits that aren't persisted yet. The live preview reflects the draft,
 * so this makes clear the state is *shown but not saved* and offers Save / Discard.
 *
 * It carries its OWN frosted surface (a theme-aware amber tint at high opacity +
 * a strong backdrop blur) rather than relying on whatever sits behind it — so the
 * text stays legible in light mode, dark mode, and when it scrolls over the dark
 * preview or a bright photo. The amber accent keeps the "caution" read; the
 * message uses gray-12 for maximum contrast against the tint in either theme.
 */
export function UnsavedBanner({
  message = "Unsaved changes — the preview shows your edits, but they're not saved yet.",
  saving = false,
  onSave,
  onDiscard,
  className,
  compact = false,
}: {
  message?: string;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  className?: string;
  /** Compact pill form (icon + "Unsaved" + Save/Discard) for floating as an
   *  overlay so it doesn't reserve layout space / shift content. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-full border border-amber-6 bg-amber-2/90 py-1 pl-3.5 pr-2 shadow-lg backdrop-blur-xl",
          className,
        )}
      >
        <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-11" />
        <span className="text-caption2 font-medium text-gray-12">Unsaved</span>
        <Button variant="transparent" size="small" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button variant="accent" size="small" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex items-center gap-3 rounded-xl border border-amber-6 bg-amber-2/90 px-3 py-2 shadow-sm backdrop-blur-xl",
        className,
      )}
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-amber-11" />
      <span className="flex-1 min-w-0 text-caption1 font-medium text-gray-12">{message}</span>
      <Button variant="transparent" size="small" onClick={onDiscard} disabled={saving}>
        Discard
      </Button>
      <Button variant="accent" size="small" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
