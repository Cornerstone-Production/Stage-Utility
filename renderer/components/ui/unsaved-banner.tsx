import { TriangleAlertIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/cn";

/**
 * A prominent, sticky "unsaved changes" bar shown at the top of an editor when it
 * has draft edits that aren't persisted yet. The live preview reflects the draft,
 * so this makes clear the state is *shown but not saved* and offers Save / Discard.
 */
export function UnsavedBanner({
  message = "Unsaved changes — the preview shows your edits, but they're not saved yet.",
  saving = false,
  onSave,
  onDiscard,
  className,
}: {
  message?: string;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex items-center gap-3 rounded-xl border border-amber-a5 bg-amber-a2 px-3 py-2 backdrop-blur",
        className,
      )}
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-amber-11" />
      <span className="flex-1 min-w-0 text-caption1 text-amber-11">{message}</span>
      <Button variant="transparent" size="small" onClick={onDiscard} disabled={saving}>
        Discard
      </Button>
      <Button variant="accent" size="small" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
