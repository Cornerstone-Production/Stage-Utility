import { Button } from "./button";
import { cn } from "../../lib/cn";

/**
 * A prominent, sticky "unsaved changes" bar shown at the top of an editor when it
 * has draft edits that aren't persisted yet. The live preview reflects the draft,
 * so this makes clear the state is *shown but not saved* and offers Save / Discard.
 *
 * It carries its OWN frosted surface (a neutral popover tint at high opacity +
 * a strong backdrop blur) rather than relying on whatever sits behind it — so the
 * text stays legible in light mode, dark mode, and when it scrolls over the dark
 * preview or a bright photo. Neutral rather than amber: "you have not pressed Save"
 * is pending, not wrong, and amber earns more as a signal when it is reserved for
 * things that ARE wrong (over-time, errors). See STYLE_GUIDE 2.3. The
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
          "flex items-center gap-2 rounded-lg border border-line-strong bg-popover px-2.5 py-1.5 shadow-md backdrop-blur-xl",
          className,
        )}
      >
        <span className="text-caption1 text-fg-muted">Unsaved changes</span>
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
        "sticky top-0 z-20 flex items-center gap-3 rounded-lg border border-line-strong bg-popover px-3 py-2 shadow-md backdrop-blur-xl",
        className,
      )}
    >
      <span className="flex-1 min-w-0 text-caption1 text-fg-muted">{message}</span>
      <Button variant="transparent" size="small" onClick={onDiscard} disabled={saving}>
        Discard
      </Button>
      <Button variant="accent" size="small" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
